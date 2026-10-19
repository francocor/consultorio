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
import { voucherMatches, type VoucherFacts } from '../domain/voucher-match.js';

import { LOCK_NOT_AVAILABLE, UNIQUE_VIOLATION, constraintOf, sqlState } from './common.js';
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
  /**
   * How long the mark, written on the connection of its own, waits for a row lock before it gives up
   * and the attempt is left for the sweeper (default 5 seconds). Without it a mark that waits for a
   * row would hold two connections of the pool at once for as long as the other one lasts (JD-S4 R2-3).
   */
  markLockTimeoutMs?: number | undefined;
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

/** The document of the recipient as the authority is told it, or null when the invoice has none. */
function buyerOf(row: InvoiceRow): { type: 'cuit' | 'dni'; number: string } | null {
  return row.recipientDocType !== null && row.recipientDocNumber !== null
    ? {
        type: row.recipientDocType === 'dni' ? 'dni' : 'cuit',
        number: row.recipientDocNumber,
      }
    : null;
}

/** The voucher a credit note cancels (once it has a number), or undefined for anything else. */
async function associatedOf(
  tx: Tx,
  row: InvoiceRow,
): Promise<{ type: string; pointOfSale: number; number: number } | undefined> {
  if (row.creditNoteOfId === null) return undefined;
  const [original] = await tx
    .select({ type: invoice.type, pointOfSale: invoice.pointOfSale, number: invoice.number })
    .from(invoice)
    .where(eq(invoice.id, row.creditNoteOfId));
  return original && original.number !== null
    ? { type: original.type, pointOfSale: original.pointOfSale, number: original.number }
    : undefined;
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
  const associated = await associatedOf(tx, row);
  const buyer = buyerOf(row);
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
    ...(buyer ? { buyerDocument: buyer } : {}),
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

/** How many numbers after a taken one are asked about before the attempt gives up and asks a person. */
const FORWARD_PROBES = 5;

/**
 * After an unknown outcome, or a crash, the authority is asked about the number the voucher is
 * expected to have, BEFORE anything is sent (design 5.5). The answers:
 *
 * - it holds a voucher there that is this invoice's (type, point of sale and number by the question;
 *   total, date, issuer, recipient and, for a credit note, the voucher it cancels, by comparison):
 *   it is adopted, and nothing is issued;
 * - it holds a voucher there that is the voucher of another invoice of ours (so ours never got that
 *   number): the numbers after the highest we know of are asked about in turn (up to
 *   `FORWARD_PROBES`), and each is judged the same way;
 * - it holds none: the request goes out. It is the only answer that sends;
 * - it holds a voucher there that is not this invoice's, or it refuses the question, or it does not
 *   answer: nothing is sent.
 */
async function reconcile(
  tx: Tx,
  issuer: InvoiceIssuer,
  row: InvoiceRow,
  step: { issuer: IssuerSnapshot; tenantRef: string },
): Promise<Verdict | { kind: 'send'; refresh: boolean }> {
  if (row.expectedNumber === null) return { kind: 'send', refresh: true };
  const facts: VoucherFacts = {
    issuerCuit: step.issuer.cuit,
    totalCents: row.totalCents,
    issueDate: row.issueDate,
    buyerDocument: buyerOf(row),
    associatedVoucher: (await associatedOf(tx, row)) ?? null,
  };
  let number = row.expectedNumber;
  let refresh = false;
  let last = number;
  for (let probes = 0; probes <= FORWARD_PROBES; probes += 1) {
    const probe = await issuer
      .findIssued({
        issuerCuit: step.issuer.cuit,
        tenantRef: step.tenantRef,
        pointOfSale: row.pointOfSale,
        type: row.type,
        number,
      })
      .catch((): IssueResult => ({
        status: 'retryable',
        message: 'unreachable',
        outcomeUnknown: true,
      }));
    if (probe === null) return { kind: 'send', refresh };
    // An authority that cannot answer, or that refuses the question (a token, an environment), has
    // not said that nothing is there: sending now could issue a second voucher (JD-S4 R2-A-W4).
    if (probe.status !== 'issued') return { kind: 'retry', unknown: true };
    last = probe.number;
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
    if (!other) {
      return voucherMatches(probe, facts)
        ? { kind: 'issued', result: probe }
        : { kind: 'attention', number: probe.number, cae: probe.cae, reason: 'voucher_mismatch' };
    }
    // Ours never got it: ask about the numbers that follow instead of sending blind.
    number = Math.max(number, await highestNumberFor(tx, row)) + 1;
    refresh = true;
  }
  return { kind: 'attention', number: last, cae: null, reason: 'number_taken' };
}

/** How long an invoice waits for the one that is settled first in its series. */
const SERIES_WAIT_MS = 60_000;

/**
 * Whether another invoice of the same series (point of sale and type) waits for the authority to be
 * asked about a request that may have been answered, and goes before this one: any such invoice when
 * this one has not been sent, the older one when both have.
 */
async function olderUnsettledInSeries(tx: Tx, row: InvoiceRow): Promise<boolean> {
  const [other] = await tx
    .select({ id: invoice.id })
    .from(invoice)
    .where(
      and(
        eq(invoice.pointOfSale, row.pointOfSale),
        eq(invoice.type, row.type),
        eq(invoice.status, 'pending'),
        eq(invoice.deliveryState, 'awaiting_reconciliation'),
        ne(invoice.id, row.id),
        row.deliveryState === 'awaiting_reconciliation'
          ? sql`${invoice.id} < ${row.id}`
          : undefined,
      ),
    )
    .limit(1);
  return other !== undefined;
}

/** How long the mark waits for a row lock on its own connection (see `IssueDeps.markLockTimeoutMs`). */
const DEFAULT_MARK_LOCK_TIMEOUT_MS = 5000;

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
): Promise<InvoiceRow | null> {
  const marked = row.deliveryState === 'awaiting_reconciliation' && row.expectedNumber !== null;
  if (marked && !step.refresh) return row;
  const expectedNumber = await expectedNumberFor(tx, row);
  // True when the row was written: an invoice that is no longer pending (somebody closed it since the
  // attempt read it) matches nothing, and then the authority must not be called for it (JD-S4 R2-3).
  const write = async (target: Tx): Promise<boolean> => {
    const written = await target
      .update(invoice)
      .set({ deliveryState: 'awaiting_reconciliation', expectedNumber, lastAttemptAt: step.now })
      .where(and(eq(invoice.id, row.id), eq(invoice.status, 'pending')))
      .returning({ id: invoice.id });
    return written.length > 0;
  };
  let wrote: boolean;
  if (deps.db) {
    try {
      wrote = await createWithTenant(deps.db)({ tenantId, userId: SYSTEM_USER_ID }, async (own) => {
        // This connection is a second one for the attempt: if the row is locked by someone else it must
        // not wait for as long as that lasts, holding two connections of the pool.
        await own.execute(
          sql`select set_config('lock_timeout', ${String(deps.markLockTimeoutMs ?? DEFAULT_MARK_LOCK_TIMEOUT_MS) + 'ms'}, true)`,
        );
        return write(own);
      });
    } catch (error) {
      if (sqlState(error) === LOCK_NOT_AVAILABLE) return null;
      throw error;
    }
  } else {
    wrote = await write(tx);
  }
  return wrote ? { ...row, deliveryState: 'awaiting_reconciliation', expectedNumber } : null;
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

  // One invoice of a series (organization, point of sale, type) is in flight at a time. The number
  // an invoice is expected to get is the one after the highest we hold, so two invoices that were
  // sent together would be expecting the same one and could take each other's voucher for their own.
  // The lock is held to the end of the transaction, which spans the call to the authority; whoever
  // does not get it is left for the sweeper (JD-S4 R2-1).
  const series = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(
          'afip-attempt-series|' || current_setting('app.tenant_id') || '|' ||
          ${String(row.pointOfSale)}::text || '|' || ${row.type}::text, 0)) as locked`,
  );
  if (series.rows[0]?.locked !== true) return 'skipped';

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

  // Another invoice of the series may have been answered without us knowing: its voucher is out
  // there under a number that this one would be expecting too. Nothing of the series is sent until
  // that one is settled (adopted, parked, replaced or sent again). Among two that both wait, the
  // older goes first.
  if (await olderUnsettledInSeries(tx, row)) {
    await lockedWrite(tx, row, async () => {
      await tx
        .update(invoice)
        .set({ nextAttemptAt: new Date(now.getTime() + SERIES_WAIT_MS) })
        .where(eq(invoice.id, row.id));
    });
    return 'skipped';
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
    const marked = await markIntent(tx, deps, organization.id, row, { now, refresh });
    // Closed since it was read, or its row is locked by someone else: the authority is not called.
    if (!marked) return 'skipped';
    row = marked;
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
