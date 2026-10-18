import type { InvoiceIssuer, InvoiceRequest, IssueResult } from '@consultorio/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';

import {
  fiscalProfile,
  invoice,
  invoiceLine,
  pointOfSale,
  type InvoiceRow,
} from '../../../db/schema/index.js';
import type { AdapterResolver } from '../../../main/adapter-resolver.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import { readChargeLines } from '../../billing/index.js';
import { backoffMs } from '../domain/retry-schedule.js';

import { UNIQUE_VIOLATION, constraintOf, sqlState } from './common.js';
import { issuerFor } from './issuer.js';
import { INVOICE_PDF_JOB } from './job-names.js';
import { invoicingReadiness } from './readiness.js';
import { loadOrganization } from './settings.js';

export interface IssueDeps {
  adapters?: AdapterResolver | undefined;
  clock: () => Date;
  /** Queues the PDF of an invoice once it is issued. Without a queue nothing is queued. */
  jobs?: JobClient | undefined;
}

/** What one attempt ended in. A `retry` keeps the invoice pending, with the next attempt scheduled. */
export type AttemptOutcome = 'issued' | 'rejected' | 'retry' | 'skipped';

/** The system acts: there is no person, session or address behind an automatic attempt. */
const SYSTEM_ACTOR: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

const MAX_MESSAGE = 500;

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
 * The number the authority is expected to have given a voucher whose answer was lost: the one after
 * the highest we know of for the same point of sale and type (our own and the registered ones).
 */
async function expectedNumberFor(tx: Tx, row: InvoiceRow): Promise<number> {
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
  return (found?.highest ?? 0) + 1;
}

async function buildRequest(tx: Tx, row: InvoiceRow, issuerCuit: string): Promise<InvoiceRequest> {
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
    issuerCuit,
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
    ...(associated ? { associatedVoucher: associated } : {}),
  };
}

type Verdict =
  | { kind: 'issued'; result: Extract<IssueResult, { status: 'issued' }> }
  | { kind: 'rejected'; message: string }
  | { kind: 'retry'; unknown: boolean };

/** What the authority answered, or an unknown outcome when the call itself failed. */
async function submit(
  issuer: InvoiceIssuer,
  request: InvoiceRequest,
  row: InvoiceRow,
  issuerCuit: string,
): Promise<Verdict> {
  // After an unknown outcome the authority is asked first: while it does not answer, nothing is sent.
  if (row.deliveryState === 'awaiting_reconciliation') {
    const probe = await issuer
      .findIssued({
        issuerCuit,
        pointOfSale: row.pointOfSale,
        type: row.type,
        number: row.expectedNumber ?? 0,
      })
      .catch((): IssueResult => ({
        status: 'retryable',
        message: 'unreachable',
        outcomeUnknown: true,
      }));
    if (probe?.status === 'retryable') return { kind: 'retry', unknown: true };
  }
  // The same key always gets the same voucher, so asking again after a lost answer finds it.
  const result = await issuer
    .issue(request, row.idempotencyKey)
    .catch((): IssueResult => ({ status: 'retryable', message: 'failed', outcomeUnknown: true }));
  if (result.status === 'issued') return { kind: 'issued', result };
  if (result.status === 'rejected') return { kind: 'rejected', message: result.message };
  return { kind: 'retry', unknown: result.outcomeUnknown };
}

/** Keeps the invoice pending and schedules the next attempt (1 minute, doubling, up to 6 hours). */
async function defer(
  tx: Tx,
  row: InvoiceRow,
  step: { unknown: boolean; now: Date },
): Promise<void> {
  const attempts = row.attempts + 1;
  await tx
    .update(invoice)
    .set({
      attempts,
      lastAttemptAt: step.now,
      nextAttemptAt: new Date(step.now.getTime() + backoffMs(attempts)),
      deliveryState: step.unknown ? 'awaiting_reconciliation' : 'retrying',
      expectedNumber: step.unknown
        ? (row.expectedNumber ?? (await expectedNumberFor(tx, row)))
        : row.expectedNumber,
    })
    .where(eq(invoice.id, row.id));
}

/**
 * One attempt to get a pending invoice authorized (design 5.5, e-invoicing-afip, "AFIP outage
 * handling and no duplicate issuance"). It is safe to run at any time and any number of times:
 *
 * - one attempt per invoice at a time (an advisory lock); a second caller skips;
 * - an invoice that is not pending, or whose next attempt is not due, is left alone;
 * - after an unknown outcome the authority is asked about the expected number BEFORE anything is
 *   sent; if it does not answer, nothing is sent. Then the voucher is requested with the idempotency
 *   key of the invoice, so a voucher that was authorized and lost is found, never issued twice;
 * - a rejection is final for the attempt: the message is kept, there is no CAE, the lines are
 *   released (the database does it when the status changes);
 * - an outage or an unknown outcome keeps it pending with a longer wait each time.
 *
 * The call to the authority is made without any row lock; the charge lines and then the invoice are
 * locked only to write the answer, in the order every writer uses.
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

  const [row] = await tx.select().from(invoice).where(eq(invoice.id, invoiceId));
  if (row?.status !== 'pending') return 'skipped';
  if (row.nextAttemptAt !== null && row.nextAttemptAt.getTime() > now.getTime()) return 'skipped';

  const organization = await loadOrganization(tx);
  const issuer = issuerFor(deps.adapters, { id: organization.id, isDemo: organization.isDemo });
  const [profile] = await tx.select().from(fiscalProfile);
  const [point] = await tx
    .select()
    .from(pointOfSale)
    .where(eq(pointOfSale.number, row.pointOfSale));

  // A certificate that expired, or no issuer at all, keeps the invoice waiting: nothing is sent.
  // Switching e-invoicing off does not: what was already requested is still submitted.
  const readiness = await invoicingReadiness(
    tx,
    { adapters: deps.adapters, clock: deps.clock },
    organization,
  );
  const blocked = readiness.reasons.some((reason) => reason !== 'disabled');
  if (!issuer || !profile || !point || blocked) {
    await lockedWrite(tx, row, () => defer(tx, row, { unknown: false, now }));
    return 'retry';
  }

  const request = await buildRequest(tx, row, profile.cuit);
  const verdict = await submit(issuer, request, row, profile.cuit);

  if (verdict.kind === 'retry') {
    await lockedWrite(tx, row, () => defer(tx, row, { unknown: verdict.unknown, now }));
    return 'retry';
  }

  if (verdict.kind === 'rejected') {
    await lockedWrite(tx, row, async () => {
      await tx
        .update(invoice)
        .set({
          status: 'rejected',
          deliveryState: null,
          rejectionMessage: cleanMessage(verdict.message),
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
    return 'rejected';
  }

  const { result } = verdict;
  try {
    // A savepoint: a number that is already registered must not abort the whole attempt.
    await tx.transaction(async (inner) => {
      await lockedWrite(inner, row, async () => {
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
          },
        });
        await deps.jobs?.enqueue(inner, INVOICE_PDF_JOB, {
          tenantId: organization.id,
          invoiceId: row.id,
        });
      });
    });
    return 'issued';
  } catch (error) {
    if (sqlState(error) === UNIQUE_VIOLATION && constraintOf(error) === 'invoice_number_key') {
      // The number the authority gave is already registered as another voucher of ours (a manual
      // entry). Nothing is lost: the invoice stays pending, flagged by its age, for a person to look at.
      await lockedWrite(tx, row, () => defer(tx, row, { unknown: true, now }));
      return 'retry';
    }
    throw error;
  }
}

/**
 * Writes the answer: the charge lines first, in the order of their ids, then the invoice row. The
 * same order as the writers that create invoices and credit notes, so none of them can deadlock.
 */
async function lockedWrite(tx: Tx, row: InvoiceRow, write: () => Promise<void>): Promise<void> {
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
  // Someone else (a manual entry cannot, a duplicate attempt could not) finished it meanwhile.
  if (current?.status !== 'pending') return;
  await write();
}
