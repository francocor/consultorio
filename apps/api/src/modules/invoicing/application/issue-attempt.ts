import { createHash } from 'node:crypto';

import type {
  InvoiceIssuer,
  InvoiceRequest,
  IssueResult,
  WorklistKind,
  WorklistSubjectType,
} from '@consultorio/contracts';
import { and, asc, eq, ne, sql } from 'drizzle-orm';

import {
  fiscalProfile,
  invoice,
  invoiceLine,
  pointOfSale,
  type InvoiceRow,
} from '../../../db/schema/index.js';
import type { AdapterResolver } from '../../../main/adapter-resolver.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Db } from '../../../platform/db/pool.js';
import { SYSTEM_USER_ID, createWithTenant, type Tx } from '../../../platform/db/tenant-context.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import { readChargeLines } from '../../billing/index.js';
import { backoffMs } from '../domain/retry-schedule.js';

import { UNIQUE_VIOLATION, constraintOf, sqlState } from './common.js';
import { snapshotOfProfile, type IssuerSnapshot } from './issuer-snapshot.js';
import { issuerFor } from './issuer.js';
import { INVOICE_PDF_JOB } from './job-names.js';
import { invoicingReadiness } from './readiness.js';
import { loadOrganization } from './settings.js';

/** What invoicing asks of the reception worklist (the queue itself belongs to scheduling). */
export interface AttentionWorklist {
  openItem(
    tx: Tx,
    input: {
      kind: WorklistKind;
      subjectType: WorklistSubjectType;
      subjectId: string;
      detail?: Record<string, unknown> | undefined;
    },
  ): Promise<unknown>;
}

/** Where the failures nobody is waiting for are written (the worker's log). No message text. */
export interface AttemptLog {
  error(object: Record<string, unknown>, message: string): void;
}

export interface IssueDeps {
  adapters?: AdapterResolver | undefined;
  clock: () => Date;
  /** Queues the PDF of an invoice once it is issued. Without a queue nothing is queued. */
  jobs?: JobClient | undefined;
  /**
   * A connection of its own. The mark that says "the authority may be answering this" is committed
   * on it BEFORE the call, so it survives a crash of the process that made the call (JD-S4 R1-C4).
   * Without it (a caller that only has a transaction: the demo seed) the mark is written in the
   * caller's transaction and is as durable as the rest of the attempt.
   */
  db?: Db | undefined;
  /** Where an invoice that needs a person is put (the worklist of reception). */
  worklist?: AttentionWorklist | undefined;
  log?: AttemptLog | undefined;
}

/**
 * What one attempt ended in. A `retry` keeps the invoice pending, with the next attempt scheduled.
 * `attention` means the authority answered with a voucher that cannot be recorded and the invoice
 * is parked for a person; `orphaned` means it answered after the invoice was closed by someone else.
 */
export type AttemptOutcome = 'issued' | 'rejected' | 'retry' | 'skipped' | 'attention' | 'orphaned';

/** The system acts: there is no person, session or address behind an automatic attempt. */
const SYSTEM_ACTOR: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

const MAX_MESSAGE = 500;

/**
 * The key the authority is asked with: derived here from the organization and the invoice, never the
 * key the client sent. The client key is only unique inside an organization, and a simulator that
 * serves several of them would otherwise answer one with the voucher of another (JD-S4 R1-C12).
 */
export function issuerKeyOf(tenantId: string, invoiceId: string): string {
  return createHash('sha256').update(`afip-issue|${tenantId}|${invoiceId}`).digest('hex');
}

/** The words of the tax authority about a rejection, cleaned for storing and showing. */
function cleanMessage(message: string): string {
  // A control character (a line break included) becomes a space; nothing else is touched.
  let printable = '';
  for (const char of message) {
    const code = char.codePointAt(0) ?? 0;
    printable += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  const text = printable.replace(/\s+/g, ' ').trim();
  return (text === '' ? 'El comprobante fue rechazado.' : text).slice(0, MAX_MESSAGE);
}

/**
 * The highest number we know of for the same point of sale and type (our own vouchers and the
 * registered ones), or 0 when there is none.
 */
async function highestNumberFor(tx: Tx, row: InvoiceRow): Promise<number> {
  const [found] = await tx
    .select({ highest: sql<number>`coalesce(max(${invoice.number}), 0)::int` })
    .from(invoice)
    .where(
      and(
        eq(invoice.pointOfSale, row.pointOfSale),
        eq(invoice.type, row.type),
        sql`${invoice.number} is not null`,
      ),
    );
  return found?.highest ?? 0;
}

/**
 * The number the authority is expected to have given a voucher whose answer was lost: the one after
 * the highest we know of.
 */
async function expectedNumberFor(tx: Tx, row: InvoiceRow): Promise<number> {
  return (await highestNumberFor(tx, row)) + 1;
}

async function buildRequest(
  tx: Tx,
  row: InvoiceRow,
  issuer: IssuerSnapshot,
  tenantRef: string,
): Promise<InvoiceRequest> {
  const lastKnownNumber = await highestNumberFor(tx, row);
  const lines = await tx
    .select()
    .from(invoiceLine)
    .where(eq(invoiceLine.invoiceId, row.id))
    .orderBy(asc(invoiceLine.position));
  const [first] = lines;
  const associated =
    row.creditNoteOfId === null
      ? undefined
      : await tx
          .select({ type: invoice.type, pointOfSale: invoice.pointOfSale, number: invoice.number })
          .from(invoice)
          .where(eq(invoice.id, row.creditNoteOfId))
          .then(([original]) =>
            original && original.number !== null
              ? { type: original.type, pointOfSale: original.pointOfSale, number: original.number }
              : undefined,
          );
  return {
    // The issuer is the one the invoice was requested with, not the live fiscal profile (JD-S4 R1-C7).
    issuerCuit: issuer.cuit,
    tenantRef,
    environment: row.environment === 'production' ? 'production' : 'homologation',
    pointOfSale: row.pointOfSale,
    type: row.type,
    issueDate: row.issueDate,
    currency: 'ARS',
    totalCents: row.totalCents,
    ...(row.recipientDocType !== null && row.recipientDocNumber !== null
      ? {
          buyerDocument: {
            type: row.recipientDocType === 'dni' ? ('dni' as const) : ('cuit' as const),
            number: row.recipientDocNumber,
          },
        }
      : {}),
    ...(row.recipientName ? { buyerName: row.recipientName } : {}),
    buyerTaxCondition: row.recipientTaxCondition as NonNullable<
      InvoiceRequest['buyerTaxCondition']
    >,
    ...(first ? { concept: first.description } : {}),
    netCents: row.netCents,
    vatCents: row.vatCents,
    exemptCents: row.exemptCents,
    // A simulator that restarted numbers after what the organization already holds.
    ...(lastKnownNumber > 0 ? { lastKnownNumber } : {}),
    ...(associated ? { associatedVoucher: associated } : {}),
  };
}

type Issued = Extract<IssueResult, { status: 'issued' }>;

type AttentionReason = 'number_taken' | 'cae_taken' | 'voucher_mismatch';

type Verdict =
  | { kind: 'issued'; result: Issued }
  | { kind: 'rejected'; message: string }
  /** `unknown`: the request may have been answered. Otherwise the authority said it issued nothing. */
  | { kind: 'retry'; unknown: boolean }
  /** A voucher the authority holds that cannot be recorded for this invoice. */
  | { kind: 'attention'; number: number; cae: string | null; reason: AttentionReason };

/** Whether a voucher the authority holds is the one this invoice asked for. */
function matches(found: Issued, row: InvoiceRow): boolean {
  return found.totalCents === row.totalCents && found.issueDate === row.issueDate;
}

/**
 * After an unknown outcome, or a crash, the authority is asked about the number the voucher is
 * expected to have, BEFORE anything is sent (design 5.5). The answers:
 *
 * - it holds a voucher there that is this invoice's (type, point of sale and number by the question;
 *   total and date by comparison): it is adopted, and nothing is issued;
 * - it holds none, or the number is already the voucher of another invoice of ours (so ours never
 *   got it): the request goes out, with a number to expect that is refreshed in the second case;
 * - it holds a voucher there that is not this invoice's, or it does not answer: nothing is sent.
 */
async function reconcile(
  tx: Tx,
  issuer: InvoiceIssuer,
  row: InvoiceRow,
  step: { issuer: IssuerSnapshot; tenantRef: string },
): Promise<Verdict | { kind: 'send'; refresh: boolean }> {
  if (row.expectedNumber === null) return { kind: 'send', refresh: true };
  const probe = await issuer
    .findIssued({
      issuerCuit: step.issuer.cuit,
      tenantRef: step.tenantRef,
      pointOfSale: row.pointOfSale,
      type: row.type,
      number: row.expectedNumber,
    })
    .catch((): IssueResult => ({
      status: 'retryable',
      message: 'unreachable',
      outcomeUnknown: true,
    }));
  if (probe === null || probe.status === 'rejected') return { kind: 'send', refresh: false };
  if (probe.status === 'retryable') return { kind: 'retry', unknown: true };
  // The number is already the voucher of another invoice of ours: our lost request never got it.
  const [other] = await tx
    .select({ id: invoice.id })
    .from(invoice)
    .where(
      and(
        eq(invoice.pointOfSale, row.pointOfSale),
        eq(invoice.type, row.type),
        eq(invoice.number, probe.number),
        ne(invoice.id, row.id),
      ),
    )
    .limit(1);
  if (other) return { kind: 'send', refresh: true };
  if (!matches(probe, row)) {
    return { kind: 'attention', number: probe.number, cae: probe.cae, reason: 'voucher_mismatch' };
  }
  return { kind: 'issued', result: probe };
}

/**
 * Writes down, BEFORE the authority is called, that it may answer this invoice: the invoice is
 * marked `awaiting_reconciliation` with the number it is expected to get. If the process dies after
 * the authority answered, the next attempt finds the mark and asks the authority before it sends
 * anything. The mark is committed on a connection of its own when there is one (`deps.db`), so it
 * does not wait for the end of the attempt, which keeps its transaction open across the call. Only
 * a definite answer clears it.
 */
async function markIntent(
  tx: Tx,
  deps: IssueDeps,
  tenantId: string,
  row: InvoiceRow,
  step: { now: Date; refresh: boolean },
): Promise<InvoiceRow> {
  const marked = row.deliveryState === 'awaiting_reconciliation' && row.expectedNumber !== null;
  if (marked && !step.refresh) return row;
  const expectedNumber = await expectedNumberFor(tx, row);
  const write = (target: Tx) =>
    target
      .update(invoice)
      .set({ deliveryState: 'awaiting_reconciliation', expectedNumber, lastAttemptAt: step.now })
      .where(and(eq(invoice.id, row.id), eq(invoice.status, 'pending')));
  if (deps.db) {
    await createWithTenant(deps.db)({ tenantId, userId: SYSTEM_USER_ID }, async (own) => {
      await write(own);
    });
  } else {
    await write(tx);
  }
  return { ...row, deliveryState: 'awaiting_reconciliation', expectedNumber };
}

/** What the authority answered, or an unknown outcome when the call itself failed. */
async function callAuthority(
  issuer: InvoiceIssuer,
  request: InvoiceRequest,
  key: string,
): Promise<Verdict> {
  // The same key always gets the same voucher, so asking again after a lost answer finds it.
  const result = await issuer
    .issue(request, key)
    .catch((): IssueResult => ({ status: 'retryable', message: 'failed', outcomeUnknown: true }));
  if (result.status === 'issued') return { kind: 'issued', result };
  if (result.status === 'rejected') return { kind: 'rejected', message: result.message };
  return { kind: 'retry', unknown: result.outcomeUnknown };
}

/** The charges an invoice covers, for the audit entries (the actor, the charge, the number). */
async function chargeIdsOf(tx: Tx, invoiceId: string): Promise<string[]> {
  const rows = await tx
    .select({ chargeId: invoiceLine.chargeId })
    .from(invoiceLine)
    .where(eq(invoiceLine.invoiceId, invoiceId))
    .orderBy(asc(invoiceLine.chargeId));
  return [...new Set(rows.map((line) => line.chargeId))].slice(0, 50);
}

/**
 * Keeps the invoice pending and schedules the next attempt (1 minute, doubling, up to 6 hours).
 * `awaiting` says whether the request may have been answered; the number it is expected to have
 * travels with it. Every attempt that ends here is audited: which attempt, whether the outcome is
 * unknown, never the words of the authority.
 */
async function defer(
  tx: Tx,
  row: InvoiceRow,
  step: { awaiting: boolean; expectedNumber: number | null; now: Date },
): Promise<void> {
  const attempts = row.attempts + 1;
  await tx
    .update(invoice)
    .set({
      attempts,
      lastAttemptAt: step.now,
      nextAttemptAt: new Date(step.now.getTime() + backoffMs(attempts)),
      deliveryState: step.awaiting ? 'awaiting_reconciliation' : 'retrying',
      expectedNumber: step.awaiting ? step.expectedNumber : null,
    })
    .where(eq(invoice.id, row.id));
  await audit(tx, {
    action: 'invoice.attempted',
    outcome: 'allow',
    actor: SYSTEM_ACTOR,
    resourceType: 'invoice',
    resourceId: row.id,
    ...(row.patientId ? { patientId: row.patientId } : {}),
    metadata: {
      type: row.type,
      attempt: attempts,
      unknown: step.awaiting,
      chargeIds: await chargeIdsOf(tx, row.id),
    },
  });
}

/**
 * One attempt to get a pending invoice authorized (design 5.5, e-invoicing-afip, "AFIP outage
 * handling and no duplicate issuance"). It is safe to run at any time and any number of times:
 *
 * - one attempt per invoice at a time (an advisory lock); a second caller skips;
 * - an invoice that is not pending, whose next attempt is not due, or that waits for a person
 *   (`needs_attention`), is left alone;
 * - the request is the one the invoice was made with: the issuer is the snapshot taken when it was
 *   requested, and the key the authority sees is derived from the organization and the invoice;
 * - after an unknown outcome, or after a crash, the authority is asked about the expected number
 *   BEFORE anything is sent; a voucher that is this invoice's is adopted, never issued twice. The
 *   mark that makes this possible is committed before every call (`markIntent`);
 * - a rejection is final for the attempt: the message is kept, there is no CAE, the lines are
 *   released (the database does it when the status changes);
 * - an outage or an unknown outcome keeps it pending with a longer wait each time;
 * - a voucher whose number is already one of ours is not retried: the invoice is parked and a person
 *   is told (worklist), because every retry could issue another real voucher.
 *
 * The call to the authority is made without any row lock (the transaction of the caller stays open
 * across it, holding only the advisory lock); the charge lines and then the invoice are locked only
 * to write the answer, in the order every writer uses.
 */
export async function attemptIssue(
  tx: Tx,
  deps: IssueDeps,
  invoiceId: string,
): Promise<AttemptOutcome> {
  const now = deps.clock();
  const lock = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${'afip-invoice|' + invoiceId}, 0)) as locked`,
  );
  if (lock.rows[0]?.locked !== true) return 'skipped';

  const [found] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
  if (found?.status !== 'pending') return 'skipped';
  if (found.deliveryState === 'needs_attention') return 'skipped';
  if (found.nextAttemptAt !== null && found.nextAttemptAt.getTime() > now.getTime()) {
    return 'skipped';
  }
  let row: InvoiceRow = found;

  const organization = await loadOrganization(tx);
  const issuer = issuerFor(deps.adapters, { id: organization.id, isDemo: organization.isDemo });
  const [profile] = await tx.select().from(fiscalProfile);
  const [point] = await tx
    .select()
    .from(pointOfSale)
    .where(eq(pointOfSale.number, row.pointOfSale));
  // The issuer of the voucher: the snapshot, or the profile for an invoice that predates it.
  const snapshot = row.issuerSnapshot ?? (profile ? snapshotOfProfile(profile) : null);

  // A certificate that expired, or no issuer at all, keeps the invoice waiting: nothing is sent.
  // Switching e-invoicing off does not: what was already requested is still submitted.
  const readiness = await invoicingReadiness(
    tx,
    { adapters: deps.adapters, clock: deps.clock },
    organization,
  );
  const blocked = readiness.reasons.some((reason) => reason !== 'disabled');
  if (!issuer || !snapshot || !point || blocked) {
    // Nothing was sent, so nothing is learned: a mark from an earlier attempt stays.
    const wrote = await lockedWrite(tx, row, () =>
      defer(tx, row, {
        awaiting: row.deliveryState === 'awaiting_reconciliation',
        expectedNumber: row.expectedNumber,
        now,
      }),
    );
    return wrote ? 'retry' : 'skipped';
  }

  let verdict: Verdict | undefined;
  let refresh = false;
  if (row.deliveryState === 'awaiting_reconciliation') {
    const reconciled = await reconcile(tx, issuer, row, {
      issuer: snapshot,
      tenantRef: organization.id,
    });
    if (reconciled.kind === 'send') refresh = reconciled.refresh;
    else verdict = reconciled;
  }
  if (!verdict) {
    row = await markIntent(tx, deps, organization.id, row, { now, refresh });
    const request = await buildRequest(tx, row, snapshot, organization.id);
    verdict = await callAuthority(issuer, request, issuerKeyOf(organization.id, row.id));
  }

  if (verdict.kind === 'retry') {
    const { unknown } = verdict;
    const wrote = await lockedWrite(tx, row, () =>
      defer(tx, row, {
        awaiting: unknown,
        // The authority was asked and could not say: the mark stays. A definite "nothing issued"
        // clears it.
        expectedNumber: row.expectedNumber,
        now,
      }),
    );
    return wrote ? 'retry' : 'skipped';
  }

  if (verdict.kind === 'rejected') {
    const message = verdict.message;
    const wrote = await lockedWrite(tx, row, async () => {
      await tx
        .update(invoice)
        .set({
          status: 'rejected',
          deliveryState: null,
          rejectionMessage: cleanMessage(message),
          attempts: row.attempts + 1,
          lastAttemptAt: now,
          nextAttemptAt: null,
          expectedNumber: null,
        })
        .where(eq(invoice.id, row.id));
      await audit(tx, {
        action: 'invoice.rejected',
        outcome: 'allow',
        actor: SYSTEM_ACTOR,
        resourceType: 'invoice',
        resourceId: row.id,
        ...(row.patientId ? { patientId: row.patientId } : {}),
        metadata: { type: row.type, attempts: row.attempts + 1 },
      });
    });
    return wrote ? 'rejected' : 'skipped';
  }

  if (verdict.kind === 'attention') {
    const wrote = await park(tx, deps, row, now, verdict);
    return wrote ? 'attention' : 'skipped';
  }

  const { result } = verdict;
  let wrote: boolean;
  try {
    // A savepoint: a number that is already registered must not abort the whole attempt.
    wrote = await tx.transaction((inner) =>
      lockedWrite(inner, row, async () => {
        await inner
          .update(invoice)
          .set({
            status: 'issued',
            deliveryState: null,
            number: result.number,
            cae: result.cae,
            caeExpiresOn: result.caeExpiresOn,
            issuedAt: now,
            attempts: row.attempts + 1,
            lastAttemptAt: now,
            nextAttemptAt: null,
            expectedNumber: null,
          })
          .where(eq(invoice.id, row.id));
        await audit(inner, {
          action: 'invoice.issued',
          outcome: 'allow',
          actor: SYSTEM_ACTOR,
          resourceType: 'invoice',
          resourceId: row.id,
          ...(row.patientId ? { patientId: row.patientId } : {}),
          metadata: {
            type: row.type,
            pointOfSale: row.pointOfSale,
            number: result.number,
            totalCents: row.totalCents,
            simulated: row.simulated,
            chargeIds: await chargeIdsOf(inner, row.id),
          },
        });
        await deps.jobs?.enqueue(inner, INVOICE_PDF_JOB, {
          tenantId: organization.id,
          invoiceId: row.id,
        });
      }),
    );
  } catch (error) {
    const reason = collisionOf(error);
    if (reason) {
      // The authority gave a number (or a CAE) that already belongs to one of our vouchers: a manual
      // entry, or the numbering of another environment. Trying again could issue another real
      // voucher each time: the invoice is parked for a person.
      const parked = await park(tx, deps, row, now, {
        number: result.number,
        cae: result.cae,
        reason,
      });
      return parked ? 'attention' : 'skipped';
    }
    throw error;
  }
  if (wrote) return 'issued';

  // The authority issued a voucher for an invoice that is no longer pending: somebody closed it while
  // the request was in flight. The voucher exists and nothing records it: say so loudly.
  await recordOrphan(tx, deps, row, result);
  return 'orphaned';
}

/** Which of our unique indexes the voucher of the authority collided with, if it is one of them. */
function collisionOf(error: unknown): AttentionReason | undefined {
  if (sqlState(error) !== UNIQUE_VIOLATION) return undefined;
  const constraint = constraintOf(error);
  if (constraint === 'invoice_number_key') return 'number_taken';
  if (constraint === 'invoice_cae_key') return 'cae_taken';
  return undefined;
}

/**
 * Parks a pending invoice for a person: no automatic attempt touches it again. It writes the audit
 * entry, opens the worklist item and logs the number (never a message). Returns whether it wrote.
 */
async function park(
  tx: Tx,
  deps: IssueDeps,
  row: InvoiceRow,
  now: Date,
  found: { number: number; cae: string | null; reason: AttentionReason },
): Promise<boolean> {
  const wrote = await lockedWrite(tx, row, async () => {
    await tx
      .update(invoice)
      .set({
        deliveryState: 'needs_attention',
        attempts: row.attempts + 1,
        lastAttemptAt: now,
        nextAttemptAt: null,
        expectedNumber: null,
      })
      .where(eq(invoice.id, row.id));
    await audit(tx, {
      action: 'invoice.needs_attention',
      outcome: 'allow',
      actor: SYSTEM_ACTOR,
      resourceType: 'invoice',
      resourceId: row.id,
      ...(row.patientId ? { patientId: row.patientId } : {}),
      metadata: {
        type: row.type,
        pointOfSale: row.pointOfSale,
        number: found.number,
        cae: found.cae,
        reason: found.reason,
        environment: row.environment,
      },
    });
    await deps.worklist?.openItem(tx, {
      kind: 'invoice_attention',
      subjectType: 'invoice',
      subjectId: row.id,
      detail: {
        reason: found.reason,
        type: row.type,
        pointOfSale: row.pointOfSale,
        number: found.number,
        cae: found.cae,
      },
    });
  });
  if (wrote) {
    deps.log?.error(
      {
        invoiceId: row.id,
        type: row.type,
        pointOfSale: row.pointOfSale,
        number: found.number,
        cae: found.cae,
        reason: found.reason,
      },
      'an invoice needs attention: the authority issued a voucher that cannot be recorded',
    );
  }
  return wrote;
}

/** A voucher exists at the authority and no invoice holds it: audit, log and worklist. */
async function recordOrphan(
  tx: Tx,
  deps: IssueDeps,
  row: InvoiceRow,
  result: Issued,
): Promise<void> {
  await audit(tx, {
    action: 'invoice.voucher_orphaned',
    outcome: 'allow',
    actor: SYSTEM_ACTOR,
    resourceType: 'invoice',
    resourceId: row.id,
    ...(row.patientId ? { patientId: row.patientId } : {}),
    metadata: {
      type: row.type,
      pointOfSale: row.pointOfSale,
      number: result.number,
      cae: result.cae,
      totalCents: row.totalCents,
      simulated: row.simulated,
    },
  });
  await deps.worklist?.openItem(tx, {
    kind: 'invoice_attention',
    subjectType: 'invoice',
    subjectId: row.id,
    detail: {
      reason: 'orphaned_voucher',
      type: row.type,
      pointOfSale: row.pointOfSale,
      number: result.number,
      cae: result.cae,
    },
  });
  deps.log?.error(
    {
      invoiceId: row.id,
      type: row.type,
      pointOfSale: row.pointOfSale,
      number: result.number,
      cae: result.cae,
    },
    'a voucher was issued for an invoice that was no longer pending',
  );
}

/**
 * Writes the answer: the charge lines first, in the order of their ids, then the invoice row. The
 * same order as the writers that create invoices and credit notes, so none of them can deadlock.
 * Returns whether it wrote: an invoice that is no longer pending (somebody closed it while the
 * authority was being asked) is left as it is, and the caller says what happened.
 */
async function lockedWrite(tx: Tx, row: InvoiceRow, write: () => Promise<void>): Promise<boolean> {
  const lines = await tx
    .select({ chargeLineId: invoiceLine.chargeLineId })
    .from(invoiceLine)
    .where(eq(invoiceLine.invoiceId, row.id));
  await readChargeLines(
    tx,
    lines.map((line) => line.chargeLineId),
    { lock: true },
  );
  const [current] = await tx
    .select({ status: invoice.status })
    .from(invoice)
    .where(eq(invoice.id, row.id))
    .for('update');
  if (current?.status !== 'pending') return false;
  await write();
  return true;
}
