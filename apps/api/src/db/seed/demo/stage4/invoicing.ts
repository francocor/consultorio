import {
  CreateCreditNoteRequest,
  CreateInvoiceRequest,
  CreateManualInvoiceRequest,
  UpsertFiscalProfileRequest,
  CreatePointOfSaleRequest,
  type InvoiceDto,
} from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';

import {
  createFakeInvoiceIssuer,
  type FakeInvoiceIssuer,
} from '../../../../adapters/afip-fake/index.js';
import type { AdapterResolver } from '../../../../main/adapter-resolver.js';
import { visibleLocationIds } from '../../../../modules/access/index.js';
import {
  createInvoice,
  type InvoicingDeps,
} from '../../../../modules/invoicing/application/create-invoice.js';
import { createCreditNote } from '../../../../modules/invoicing/application/credit-note.js';
import {
  createPointOfSale,
  upsertFiscalProfile,
} from '../../../../modules/invoicing/application/fiscal-config.js';
import { storeInvoiceDocument } from '../../../../modules/invoicing/application/invoice-document.js';
import { loadInvoice } from '../../../../modules/invoicing/application/invoice-view.js';
import { attemptIssue } from '../../../../modules/invoicing/application/issue-attempt.js';
import { registerManualInvoice } from '../../../../modules/invoicing/application/manual-invoice.js';
import { localParts } from '../../../../modules/scheduling/domain/time.js';
import type { Tx } from '../../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../../platform/db/uuid.js';
import { tenant } from '../../../schema/tenant.js';

import type { BillingSeed, SeededCharge } from './billing.js';
import {
  actorOf,
  addDays,
  contextOf,
  localInstant,
  syntheticCuit,
  viewerOf,
  type Person,
  type Stage4Context,
  type Stage4People,
} from './shared.js';

/**
 * The invoicing part of the demonstration (tasks 4.63, DEM-03): the fiscal identity of the
 * organization and, over the charges of billing, invoices in every state, all of them through an
 * in-memory fake issuer that reaches nothing outside the process:
 *
 * - most paid visits have a Factura C, some for a part of the charge, and the latest ones are left
 *   for reception to invoice;
 * - the payers with a CUIT (OSDE, Swiss Medical) have an invoice for their portion; the one without
 *   (Galeno) has none, and the screen points at the payer settings;
 * - one credit note for a part of an invoice and one for the whole of another;
 * - one invoice rejected and left so, one rejected and issued again;
 * - one registered by hand: the authority did not answer, the invoice stayed pending, and the owner
 *   issued the voucher in the web tool of the authority and registered it in place of the pending
 *   one (which ends rejected, "replaced by a manual voucher").
 *
 * Not seeded: an invoice flagged as a prolonged outage. The flag is computed from the age of the
 * invoice, and a database trigger only accepts the lines of an invoice in the transaction that
 * creates it (the row is stamped with the transaction time), so an old pending invoice cannot be
 * written. The flag is shown live: the provider console puts the issuer in an outage and the
 * threshold of the organization decides when a waiting invoice is flagged.
 *
 * The numbers continue after the vouchers the organization holds, so the fake that serves the demo
 * (which numbers from its own memory) never collides with them (see `lastKnownNumber`).
 */

/** The hour of the day at which the vouchers of a day are issued. */
const ISSUE_AT = '19:00';

interface Run {
  context: Stage4Context;
  people: Stage4People;
  billing: BillingSeed;
  issuer: FakeInvoiceIssuer;
  deps: InvoicingDeps;
  clock: { at: Date };
  stats: { issued: InvoiceDto[] };
  /** The places reception works at; the administration takes the rest. */
  receptionPlaces: readonly string[] | 'all';
}

const ONE_PESO = 100;

function wholePesos(cents: number): number {
  return Math.max(ONE_PESO, Math.floor(cents / ONE_PESO) * ONE_PESO);
}

export async function seedInvoicing(
  context: Stage4Context,
  people: Stage4People,
  billing: BillingSeed,
): Promise<void> {
  const issuer = createFakeInvoiceIssuer();
  const adapters = {
    forTenant: (_tenant: unknown, port: string) => (port === 'invoiceIssuer' ? issuer : undefined),
  } as unknown as AdapterResolver;
  const clock = { at: context.now };
  const run: Run = {
    context,
    people,
    billing,
    issuer,
    deps: { adapters, clock: () => clock.at },
    clock,
    stats: { issued: [] },
    receptionPlaces: await context.withTenant(contextOf(context, people.owner), (tx) =>
      visibleLocationIds(tx, viewerOf(people.reception)),
    ),
  };

  await setUpFiscalIdentity(run);

  const today = localParts('America/Argentina/Buenos_Aires', context.now).date;
  // What is settled by now: paid visits of the days before yesterday; the rest stays to be invoiced.
  const history = billing.charges.filter(
    (made) => made.status === 'paid' && made.day <= addDays(today, -2) && patientPortion(made) > 0,
  );

  // 1. Patient invoices.
  let rejected = 0;
  let retried = 0;
  let manual = 0;
  for (const [index, made] of history.entries()) {
    const special = specialOf(index);
    if (special === 'skip') continue;
    const lines = made.lines.filter((line) => line.portion === 'patient' && line.amountCents > 0);
    const partial = index % 9 === 7 && lines.length > 0;
    const requested = lines.map((line, position) => ({
      chargeLineId: line.id,
      ...(partial && position === 0 ? { amountCents: wholePesos(line.amountCents * 0.6) } : {}),
    }));
    if (requested.length === 0) continue;

    if (special === 'rejected' && rejected === 0) {
      rejected += 1;
      run.issuer.setMode('reject_next');
      await invoiceAndSubmit(run, made, requested);
      run.issuer.setMode('ok');
    } else if (special === 'rejected_retry' && retried === 0) {
      retried += 1;
      run.issuer.setMode('reject_next');
      const first = await invoiceAndSubmit(run, made, requested);
      run.issuer.setMode('ok');
      await invoiceAndSubmit(run, made, requested, { previousAttemptId: first.id });
    } else if (special === 'manual' && manual === 0) {
      manual += 1;
      await registerByHand(run, made, requested);
    } else {
      const created = await invoiceAndSubmit(run, made, requested);
      if (created.status === 'issued') run.stats.issued.push(created);
    }
  }

  // 2. Invoices to the payers that have a CUIT, over the portion they owe.
  await invoicePayers(run, history);

  // 3. Credit notes: one for a part of an invoice, one for the whole of another.
  const target = run.stats.issued.filter((entry) => entry.kind === 'invoice');
  const partialNote = target[1];
  const totalNote = target[3];
  if (partialNote) {
    await creditNote(run, partialNote, {
      amountCents: wholePesos(partialNote.totalCents * 0.4),
      reason: 'Error en el importe: se cobró un concepto que no correspondía',
    });
  }
  if (totalNote) {
    await creditNote(run, totalNote, { reason: 'Factura emitida a nombre de otra persona' });
  }

  // 4. The documents of the vouchers that were issued.
  if (context.documents) await renderDocuments(run, people.owner);
}

type Special = 'skip' | 'rejected' | 'rejected_retry' | 'manual' | null;

/** What happens to the n-th settled visit: most are invoiced; a few are the interesting cases. */
function specialOf(index: number): Special {
  switch (index) {
    case 2:
      return 'rejected';
    case 5:
      return 'rejected_retry';
    case 8:
      return 'manual';
    default:
      // One in four is left for reception to invoice.
      return index % 4 === 3 ? 'skip' : null;
  }
}

const patientPortion = (made: SeededCharge) =>
  made.lines
    .filter((line) => line.portion === 'patient')
    .reduce((sum, line) => sum + line.amountCents, 0);

/** The moment, on a day, at which the vouchers are issued (never in the future). */
function issueMoment(run: Run, made: SeededCharge): Date {
  const place = run.billing.locations.get(made.locationId);
  const at = localInstant(place?.timeZone ?? 'America/Argentina/Buenos_Aires', made.day, ISSUE_AT);
  return new Date(Math.min(at.getTime(), run.context.now.getTime()));
}

/** Who sits at the desk of a place: reception where it works, the owner at the other places. */
function deskOf(run: Run, locationId: string): Person {
  const { receptionPlaces, people } = run;
  return receptionPlaces === 'all' || receptionPlaces.includes(locationId)
    ? people.reception
    : people.owner;
}

function at(run: Run, moment: Date): void {
  run.clock.at = moment;
}

async function setUpFiscalIdentity(run: Run): Promise<void> {
  const { context, people } = run;
  const owner = people.owner;
  const actor = actorOf(owner);
  await context.withTenant(contextOf(context, owner), async (tx) => {
    // The organization switched e-invoicing on.
    await tx
      .update(tenant)
      .set({
        settings: sql`jsonb_set(coalesce(${tenant.settings}, '{}'::jsonb), '{integrations}', coalesce(${tenant.settings} -> 'integrations', '{}'::jsonb) || '{"einvoicing": true}'::jsonb, true)`,
      })
      .where(eq(tenant.id, context.tenantId));
    const [organization] = await tx
      .select({ name: sql<string | null>`${tenant.theme} ->> 'displayName'` })
      .from(tenant);
    await upsertFiscalProfile(
      tx,
      { adapters: run.deps.adapters, clock: run.deps.clock },
      {
        actor,
        tenantId: context.tenantId,
        request: UpsertFiscalProfileRequest.parse({
          cuit: syntheticCuit(900),
          taxCondition: 'monotributo',
          businessName: organization?.name ?? 'Centro Médico de demostración',
          address: 'Av. Corrientes 1234, Ciudad Autónoma de Buenos Aires',
          activityStartedOn: '2019-03-01',
        }),
      },
    );
    await createPointOfSale(
      tx,
      { adapters: run.deps.adapters, clock: run.deps.clock },
      { actor, tenantId: context.tenantId, request: CreatePointOfSaleRequest.parse({ number: 1 }) },
    );
  });
}

/** Asks for the invoice over some lines and lets the issuer answer: issued, rejected or pending. */
async function invoiceAndSubmit(
  run: Run,
  made: SeededCharge,
  lines: readonly { chargeLineId: string; amountCents?: number }[],
  extra: { previousAttemptId?: string } = {},
  recipient: { kind: 'patient' } | { kind: 'payer' } = { kind: 'patient' },
  by?: Person,
): Promise<InvoiceDto> {
  const { context } = run;
  const desk = by ?? deskOf(run, made.locationId);
  at(run, issueMoment(run, made));
  return context.withTenant(contextOf(context, desk), async (tx) => {
    const created = await createInvoice(tx, run.deps, {
      request: CreateInvoiceRequest.parse({
        idempotencyKey: uuidv7(),
        lines,
        recipient,
        ...extra,
      }),
      actor: actorOf(desk),
      viewer: viewerOf(desk),
      tenantId: context.tenantId,
    });
    await attemptIssue(tx, run.deps, created.id);
    return readBack(run, tx, created.id);
  });
}

async function readBack(run: Run, tx: Tx, id: string): Promise<InvoiceDto> {
  const found = await loadInvoice(tx, run.deps.clock, id, { kind: 'all' });
  if (!found) throw new Error('The invoice just made cannot be read.');
  return found;
}

/** The owner registers a voucher made in the web tool of the authority. */
async function registerByHand(
  run: Run,
  made: SeededCharge,
  lines: readonly { chargeLineId: string; amountCents?: number }[],
): Promise<void> {
  const { context, people } = run;
  const owner = people.owner;
  const desk = deskOf(run, made.locationId);
  at(run, issueMoment(run, made));
  await context.withTenant(contextOf(context, owner), async (tx) => {
    const [highest] = (
      await tx.execute<{ highest: number }>(
        sql`SELECT coalesce(max(number), 0)::int AS highest FROM invoice WHERE type = 'FC' AND point_of_sale = 1`,
      )
    ).rows;
    const number = (highest?.highest ?? 0) + 1;
    // The authority was down when the invoice was requested: it stayed pending.
    run.issuer.setMode('down');
    const waiting = await createInvoice(tx, run.deps, {
      request: CreateInvoiceRequest.parse({
        idempotencyKey: uuidv7(),
        lines,
        recipient: { kind: 'patient' },
      }),
      actor: actorOf(desk),
      viewer: viewerOf(desk),
      tenantId: context.tenantId,
    });
    await attemptIssue(tx, run.deps, waiting.id);
    run.issuer.setMode('ok');
    const total = made.lines
      .filter((line) => lines.some((entry) => entry.chargeLineId === line.id))
      .reduce((sum, line) => sum + line.amountCents, 0);
    await registerManualInvoice(tx, run.deps, {
      request: CreateManualInvoiceRequest.parse({
        idempotencyKey: uuidv7(),
        type: 'FC',
        pointOfSale: 1,
        number,
        cae: `7${String(number).padStart(13, '0')}`,
        issueDate: made.day,
        totalCents: total,
        replacesInvoiceId: waiting.id,
        lines,
        recipient: { kind: 'patient' },
      }),
      actor: actorOf(owner),
      viewer: viewerOf(owner),
      tenantId: context.tenantId,
    });
  });
}

async function invoicePayers(run: Run, history: readonly SeededCharge[]): Promise<void> {
  const settledOn = history.reduce((latest, made) => (made.day > latest ? made.day : latest), '');
  const { billing } = run;
  const withCuit = [...billing.payers.values()].filter(
    (payer) => payer.cuit !== null && payer.active,
  );
  for (const payer of withCuit) {
    const owed = history.flatMap((made) =>
      made.tenantPayerId === payer.id
        ? made.lines
            .filter((line) => line.portion === 'payer' && line.amountCents > 0)
            .map((line) => ({ made, line }))
        : [],
    );
    if (owed.length === 0) continue;
    // One invoice for the first lines (a settlement of several visits), a smaller one after it.
    const batches = [owed.slice(0, 4), owed.slice(4, 6)].filter((batch) => batch.length > 0);
    for (const [number, batch] of batches.entries()) {
      const last = batch[batch.length - 1];
      if (!last) continue;
      const lines = batch.map((entry, position) => ({
        chargeLineId: entry.line.id,
        // The second batch bills only a part of its last line.
        ...(number === 1 && position === batch.length - 1
          ? { amountCents: wholePesos(entry.line.amountCents * 0.5) }
          : {}),
      }));
      // The administration bills the payers once the days are settled, so the dates of the
      // vouchers keep growing with their numbers.
      const created = await invoiceAndSubmit(
        run,
        { ...last.made, day: settledOn },
        lines,
        {},
        { kind: 'payer' },
        run.people.owner,
      );
      if (created.status === 'issued') run.stats.issued.push(created);
    }
  }
}

async function creditNote(
  run: Run,
  original: InvoiceDto,
  input: { reason: string; amountCents?: number },
): Promise<void> {
  const { context, people } = run;
  const owner = people.owner;
  const issuedOn = original.issueDate;
  // The note is issued the day after the voucher it cancels (or now, if that is later than now).
  const moment = new Date(
    Math.min(
      localInstant('America/Argentina/Buenos_Aires', addDays(issuedOn, 1), '10:30').getTime(),
      context.now.getTime(),
    ),
  );
  at(run, moment);
  await context.withTenant(contextOf(context, owner), async (tx) => {
    const note = await createCreditNote(tx, run.deps, {
      invoiceId: original.id,
      request: CreateCreditNoteRequest.parse({
        idempotencyKey: uuidv7(),
        reason: input.reason,
        ...(input.amountCents ? { amountCents: input.amountCents } : {}),
      }),
      actor: actorOf(owner),
      viewer: viewerOf(owner),
      tenantId: context.tenantId,
    });
    await attemptIssue(tx, run.deps, note.id);
  });
}

/** The PDF of every voucher that was issued, stored the way the worker stores it. */
async function renderDocuments(run: Run, owner: Person): Promise<void> {
  const { context } = run;
  const storage = context.documents?.storage;
  if (!storage) return;
  const issued = await context.withTenant(
    contextOf(context, owner),
    async (tx) =>
      (
        await tx.execute<{ id: string; issued_at: Date }>(
          sql`SELECT id, issued_at FROM invoice WHERE status = 'issued' ORDER BY issued_at, id`,
        )
      ).rows,
  );
  for (const row of issued) {
    at(run, new Date(row.issued_at));
    await context.withTenant(contextOf(context, owner), (tx) =>
      storeInvoiceDocument(
        tx,
        { storage, clock: run.deps.clock },
        { tenantId: context.tenantId, invoiceId: row.id },
      ),
    );
  }
}
