import { createHash } from 'node:crypto';

import type {
  InvoiceIssuer,
  InvoiceRequest,
  IssueResult,
  LastAuthorizedResult,
} from '@consultorio/contracts';
import { and, asc, eq, gt, isNull, lte, ne, or, sql } from 'drizzle-orm';

import {
  fiscalCredential,
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
import {
  awaitingBackoffMs,
  backoffMs,
  isAttemptAudited,
  isStalled,
} from '../domain/retry-schedule.js';
import { compareVoucher, type VoucherFacts } from '../domain/voucher-match.js';

import {
  LOCK_NOT_AVAILABLE,
  UNIQUE_VIOLATION,
  constraintOf,
  sqlState,
  type InvoiceWorklist,
} from './common.js';
import { snapshotOfProfile, type IssuerSnapshot } from './issuer-snapshot.js';
import { isSimulatedIssuer, issuerFor } from './issuer.js';
import { INVOICE_PDF_JOB } from './job-names.js';
import { invoicingReadiness } from './readiness.js';
import { inSeries } from './series-scope.js';
import { loadOrganization } from './settings.js';
import {
  UNCERTAIN_REASONS,
  recordStrayVoucher,
  recordedBetween,
  straysBetween,
  type StrayReason,
} from './stray-vouchers.js';

/** What invoicing asks of the reception worklist (the queue itself belongs to scheduling). */
export type AttentionWorklist = InvoiceWorklist;

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
 * The highest number that an invoice of the same series records, or 0 when there is none: what a
 * simulator that restarted must be told to number after. It is a hint for a simulator, nothing more:
 * what the authority itself has authorized is asked of the authority (`lastAuthorized`, JD-S4 R5-1).
 */
async function highestRecordedNumberFor(
  tx: Tx,
  row: InvoiceRow,
  issuerCuit: string,
): Promise<number> {
  const [found] = await tx
    .select({ highest: sql<number>`coalesce(max(${invoice.number}), 0)::int` })
    .from(invoice)
    .where(and(inSeries(row, issuerCuit), sql`${invoice.number} is not null`));
  return found?.highest ?? 0;
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
  const lastKnownNumber = await highestRecordedNumberFor(tx, row, issuer.cuit);
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

type AttentionReason =
  'number_taken' | 'cae_taken' | 'voucher_mismatch' | 'issuer_mismatch' | 'voucher_ambiguous';

/** A number to remember when the invoice is parked: a voucher that no invoice can record sits there. */
interface StrayToRemember {
  number: number;
  reason: StrayReason;
}

/** The numbers a person must look at when an invoice is parked with a doubt (JD-S4 R5-A-F4). */
interface NumbersInDoubt {
  /** The numbers of the vouchers that could be the invoice's, lowest first (at most `MAX_CANDIDATES`). */
  candidates?: number[];
  /** A range too wide to list: every number after `candidatesFrom - 1` up to `candidatesTo`. */
  candidatesFrom?: number;
  candidatesTo?: number;
}

type Verdict =
  | {
      kind: 'issued';
      result: Issued;
      /** The invoices a number was remembered for where this voucher sits: see `settleAdoptedStrays`. */
      adoptedFrom?: string[];
    }
  | { kind: 'rejected'; message: string }
  /** `unknown`: the request may have been answered. Otherwise the authority said it issued nothing. */
  | { kind: 'retry'; unknown: boolean }
  /**
   * A voucher the authority holds that cannot be recorded for this invoice, or that cannot be told
   * apart from it. `unresolved` says that the lookup could not settle whether the request of THIS
   * invoice was answered (no authorized answer is being refused: the doubt remains). `stray` is the
   * number to remember (JD-S4 R4-3).
   */
  | ({
      kind: 'attention';
      number: number | null;
      cae: string | null;
      reason: AttentionReason;
      unresolved?: boolean;
      stray?: StrayToRemember;
    } & NumbersInDoubt);

/**
 * How many numbers of the authority a reconciliation asks about: the ones between the last number it had
 * authorized when the invoice was marked and the last one it has now, less the ones that need no
 * question (a voucher we issued ourselves, a number remembered as a voucher of somebody else). An
 * invoice that would need more is parked instead: nothing is sent when it cannot be told that nothing
 * of it is there (JD-S4 R5-1).
 */
const MAX_CANDIDATES = 20;

/** The facts of an invoice that a voucher of the authority is compared with. */
async function factsOf(tx: Tx, row: InvoiceRow, issuerCuit: string): Promise<VoucherFacts> {
  return {
    issuerCuit,
    totalCents: row.totalCents,
    issueDate: row.issueDate,
    buyerDocument: buyerOf(row),
    associatedVoucher: (await associatedOf(tx, row)) ?? null,
  };
}

type Step = { issuer: IssuerSnapshot; tenantRef: string };

/**
 * Asks the authority about a number. An authority that cannot be reached answers like one that does
 * not know: the outcome stays unknown (it is never taken for "nothing there").
 */
function askAbout(
  issuer: InvoiceIssuer,
  row: InvoiceRow,
  step: Step,
  number: number,
): Promise<IssueResult | null> {
  return issuer
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
}

/**
 * Asks the authority for the last number it has authorized in the series of the invoice (the authority's
 * own count, whoever issued the vouchers). An authority that cannot be reached, or that refuses the
 * question, has not said a number: it is never taken for zero (JD-S4 R5-1).
 */
function askLastAuthorized(
  issuer: InvoiceIssuer,
  row: InvoiceRow,
  step: Step,
): Promise<LastAuthorizedResult> {
  return issuer
    .lastAuthorized({
      issuerCuit: step.issuer.cuit,
      tenantRef: step.tenantRef,
      environment: row.environment === 'production' ? 'production' : 'homologation',
      pointOfSale: row.pointOfSale,
      type: row.type,
    })
    .catch((): LastAuthorizedResult => ({
      status: 'retryable',
      message: 'unreachable',
      outcomeUnknown: true,
    }));
}

/** A parked invoice whose lookup could not settle whether its request was answered. */
function ambiguous(found: NumbersInDoubt & { number?: number; cae?: string }): Verdict {
  return {
    kind: 'attention',
    number: found.number ?? null,
    cae: found.cae ?? null,
    reason: 'voucher_ambiguous',
    unresolved: true,
    ...(found.candidates ? { candidates: found.candidates } : {}),
    ...(found.candidatesFrom !== undefined ? { candidatesFrom: found.candidatesFrom } : {}),
    ...(found.candidatesTo !== undefined ? { candidatesTo: found.candidatesTo } : {}),
  };
}

/**
 * After an unknown outcome, or a crash, the authority is asked what it has issued SINCE the invoice was
 * marked, BEFORE anything is sent (design 5.5). The mark holds the last number the authority had
 * authorized then (`authorityLastAtMark`); a voucher of this invoice is above it. The authority is asked
 * for its last number now, and every number between the two is examined, lowest first (JD-S4 R5-1, R5-2):
 *
 * - a voucher that is this invoice's (total, date, issuer, recipient and, for a credit note, the voucher
 *   it cancels) and that no other invoice that waited for an answer could own: it is adopted;
 * - a voucher that is this invoice's and could also be the one of an invoice replaced or parked without
 *   knowing whether it had been issued, with the same facts: it cannot be told whose it is. Nothing is
 *   sent, the invoice is parked with its outcome unknown;
 * - a voucher that is nobody's of ours (another tool of the issuer, a person on the website of the
 *   authority) is remembered as such, and the next number is examined;
 * - a number that an invoice of ours records is not asked about: it is that invoice's. A voucher
 *   registered by hand is asked about and its CAE compared, since a person typed its number;
 * - when every number was examined and none is this invoice's, it was NOT issued: sending is safe.
 *
 * The answers of the authority decide, never the vouchers recorded here (a manual voucher registered out
 * of band, a mistyped number): an authority that cannot answer, that refuses the question, or whose
 * numbering does not add up leaves the invoice waiting or parked, and nothing is sent.
 */
async function reconcile(
  tx: Tx,
  issuer: InvoiceIssuer,
  row: InvoiceRow,
  step: Step,
): Promise<Verdict | { kind: 'send'; floor: number }> {
  const floor = row.authorityLastAtMark;
  // Marked before the authority's count was kept: nobody knows from where to look. A person decides.
  if (floor === null) return ambiguous({});
  const answer = await askLastAuthorized(issuer, row, step);
  // An authority that does not say its last number has not said that nothing was issued.
  if (answer.status !== 'ok') return { kind: 'retry', unknown: true };
  const last = answer.number;
  // The numbering went back (a restore, a reset of a simulator): the vouchers of the window cannot be told.
  if (last < floor) return ambiguous({ candidatesFrom: floor + 1, candidatesTo: floor });
  if (last === floor) return { kind: 'send', floor };

  const series = { pointOfSale: row.pointOfSale, type: row.type, environment: row.environment };
  const window = { from: floor, to: last };
  const recorded = new Map(
    (await recordedBetween(tx, series, step.issuer.cuit, window)).map((entry) => [
      entry.number,
      entry,
    ]),
  );
  const strays = await straysBetween(tx, series, step.issuer.cuit, window);
  const isUncertain = (reason: string) => UNCERTAIN_REASONS.includes(reason as StrayReason);
  const certain = new Set(
    strays.filter((stray) => !isUncertain(stray.reason)).map((stray) => stray.number),
  );
  const uncertain = strays.filter((stray) => isUncertain(stray.reason));
  // A voucher we issued ourselves, and a number remembered as a voucher of somebody else, need no question.
  const skipped = (number: number) =>
    certain.has(number) || (recorded.has(number) && recorded.get(number)?.status !== 'manual');
  const skippable = new Set([...recorded.keys(), ...certain].filter(skipped)).size;
  if (last - floor > MAX_CANDIDATES + skippable) {
    return ambiguous({ candidatesFrom: floor + 1, candidatesTo: last });
  }
  const numbers: number[] = [];
  for (let number = floor + 1; number <= last; number += 1) {
    if (!skipped(number)) numbers.push(number);
  }
  if (numbers.length > MAX_CANDIDATES) {
    return ambiguous({ candidatesFrom: floor + 1, candidatesTo: last });
  }

  const facts = await factsOf(tx, row, step.issuer.cuit);
  for (const number of numbers) {
    const found = await askAbout(issuer, row, step, number);
    // The authority said a voucher exists at every number up to its last, and there is none here:
    // its answers do not add up. Nothing is sent.
    if (found === null) return ambiguous({ candidates: [number] });
    if (found.status !== 'issued') return { kind: 'retry', unknown: true };
    const typed = recorded.get(number);
    // A voucher registered by hand under this number, with the CAE of this very voucher, is that one.
    if (typed && typed.cae === found.cae) continue;
    const comparison = compareVoucher(found, facts);
    if (comparison === 'differs') {
      // Not ours: nobody may take it for theirs later.
      await recordStrayVoucher(tx, row.id, row, number, 'unmatched');
      continue;
    }
    // The authority leaves out a field that would tell whether it is ours: it may be, and sending
    // now could issue a second one.
    if (comparison === 'unclear') {
      return ambiguous({ number: found.number, cae: found.cae, candidates: [number] });
    }
    // Ours, unless it is also the voucher of an invoice that was replaced or parked without knowing
    // whether it had been issued, with the same facts; or unless it contradicts what a person typed.
    let contested = typed !== undefined;
    for (const rival of uncertain) {
      if (rival.number > number || rival.invoiceId === row.id) continue;
      const [owner] = await tx.select().from(invoice).where(eq(invoice.id, rival.invoiceId));
      if (!owner) continue;
      const ownerFacts = await factsOf(tx, owner, owner.issuerSnapshot?.cuit ?? step.issuer.cuit);
      if (compareVoucher(found, ownerFacts) !== 'differs') contested = true;
    }
    if (contested) return ambiguous({ number: found.number, cae: found.cae, candidates: [number] });
    return {
      kind: 'issued',
      result: found,
      adoptedFrom: [
        ...new Set(
          uncertain
            .filter((stray) => stray.number === number && stray.invoiceId !== row.id)
            .map((stray) => stray.invoiceId),
        ),
      ],
    };
  }
  // Every number between the mark and the last one of the authority is somebody else's: this
  // invoice was not issued, and its next request gets a number above `last`.
  return { kind: 'send', floor: last };
}

/** How long an invoice that is held back waits before it is looked at again. */
const SERIES_WAIT_MS = 60_000;

/**
 * The invoice of the same series (issuer, point of sale and type) that holds this one back: the oldest one
 * that waits for the authority to be asked about a request that may have been answered, unless that is
 * this one (the same rule as `blockerOf`, in the database).
 */
async function blockerInSeries(
  tx: Tx,
  row: InvoiceRow,
  issuerCuit: string,
): Promise<{ id: string } | undefined> {
  const [oldest] = await tx
    .select({ id: invoice.id })
    .from(invoice)
    .where(
      and(
        inSeries(row, issuerCuit),
        eq(invoice.status, 'pending'),
        eq(invoice.deliveryState, 'awaiting_reconciliation'),
      ),
    )
    .orderBy(asc(invoice.id))
    .limit(1);
  return oldest !== undefined && oldest.id !== row.id ? oldest : undefined;
}

/**
 * An invoice that is held back writes only its own wait. It does NOT lock its charge lines (it writes
 * nothing about them, and a lock would make every held invoice queue behind whoever works on those
 * lines), and it never waits for a row lock: a row somebody holds is left for the next pass. It also
 * brings the blocker forward: the blocker waits for its next probe, and a probe is cheap and sends
 * nothing, so the series does not wait for the backoff of an outage that already ended (JD-S4 R3-1).
 * The blocker is brought forward at most once per `SERIES_WAIT_MS`.
 */
async function holdBack(
  tx: Tx,
  row: InvoiceRow,
  blocker: { id: string },
  now: Date,
): Promise<void> {
  const [own] = await tx
    .select({ id: invoice.id })
    .from(invoice)
    .where(and(eq(invoice.id, row.id), eq(invoice.status, 'pending')))
    .for('update', { skipLocked: true });
  if (own) {
    await tx
      .update(invoice)
      .set({ nextAttemptAt: new Date(now.getTime() + SERIES_WAIT_MS) })
      .where(eq(invoice.id, row.id));
  }
  const [due] = await tx
    .select({ id: invoice.id })
    .from(invoice)
    .where(
      and(
        eq(invoice.id, blocker.id),
        eq(invoice.status, 'pending'),
        eq(invoice.deliveryState, 'awaiting_reconciliation'),
        gt(invoice.nextAttemptAt, now),
        or(
          isNull(invoice.lastAttemptAt),
          lte(invoice.lastAttemptAt, new Date(now.getTime() - SERIES_WAIT_MS)),
        ),
      ),
    )
    .for('update', { skipLocked: true });
  if (due) {
    await tx.update(invoice).set({ nextAttemptAt: now }).where(eq(invoice.id, due.id));
  }
}

/** How long the mark waits for a row lock on its own connection (see `IssueDeps.markLockTimeoutMs`). */
const DEFAULT_MARK_LOCK_TIMEOUT_MS = 5000;

/**
 * Writes down, BEFORE the authority is called, that it may answer this invoice: the invoice is
 * marked `awaiting_reconciliation` with the last number the AUTHORITY had authorized in the series
 * (`floor`, its own answer) and the number after it, which is the one the authority is expected to give.
 * If the process dies after the authority answered, the next attempt finds the mark and asks the
 * authority what it has issued since, before it sends anything. The mark is committed on a connection
 * of its own when there is one (`deps.db`), so it does not wait for the end of the attempt, which keeps
 * its transaction open across the call. Only a definite answer clears it.
 *
 * Every mark begins a wait: a mark is written for an invoice that was not waiting, or for one whose
 * numbers up to `floor` were all examined and none is its own (the earlier wait is over, and the new
 * request is above `floor`).
 */
async function markIntent(
  tx: Tx,
  deps: IssueDeps,
  tenantId: string,
  row: InvoiceRow,
  step: { now: Date; floor: number },
): Promise<InvoiceRow | null> {
  const expectedNumber = step.floor + 1;
  // True when the row was written: an invoice that is no longer pending (somebody closed it since the
  // attempt read it) matches nothing, and then the authority must not be called for it (JD-S4 R2-3).
  const awaitingSince = step.now;
  const write = async (target: Tx): Promise<boolean> => {
    const written = await target
      .update(invoice)
      .set({
        deliveryState: 'awaiting_reconciliation',
        expectedNumber,
        authorityLastAtMark: step.floor,
        lastAttemptAt: step.now,
        awaitingSince,
      })
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
          sql`select set_config('lock_timeout', ${String(lockTimeoutOf(deps.markLockTimeoutMs)) + 'ms'}, true)`,
        );
        return write(own);
      });
    } catch (error) {
      if (sqlState(error) === LOCK_NOT_AVAILABLE) {
        // Not an error of the invoice, but a row somebody keeps locked: say so, or it goes unseen.
        deps.log?.error(
          { invoiceId: row.id },
          'the mark of an invoice gave up waiting for a row lock; the attempt is left for the sweeper',
        );
        return null;
      }
      throw error;
    }
  } else {
    wrote = await write(tx);
  }
  return wrote
    ? {
        ...row,
        deliveryState: 'awaiting_reconciliation',
        expectedNumber,
        authorityLastAtMark: step.floor,
        awaitingSince,
      }
    : null;
}

/**
 * The wait for a row lock of the mark, in whole milliseconds, at least 1. A value that is not a finite
 * number (NaN, Infinity: a setting that was read badly) is the default, not a value for the database to
 * choke on (JD-S4 R4-B-T4).
 */
function lockTimeoutOf(configured: number | undefined): number {
  return configured !== undefined && Number.isFinite(configured)
    ? Math.max(1, Math.floor(configured))
    : DEFAULT_MARK_LOCK_TIMEOUT_MS;
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
 * Keeps the invoice pending and schedules the next attempt (1 minute, doubling, up to 6 hours; an
 * invoice that waits for reconciliation is tried again within 5 minutes, because the series behind it
 * waits too). `awaiting` says whether the request may have been answered; the number it is expected
 * to have travels with it. Every attempt that ends here is audited: which attempt, whether the
 * outcome is unknown, never the words of the authority.
 */
async function defer(
  tx: Tx,
  deps: IssueDeps,
  row: InvoiceRow,
  step: { awaiting: boolean; expectedNumber: number | null; now: Date },
): Promise<void> {
  const attempts = row.attempts + 1;
  // The wait began at the first mark of the episode (an invoice that predates the column begins now).
  const awaitingSince = step.awaiting ? (row.awaitingSince ?? step.now) : null;
  await tx
    .update(invoice)
    .set({
      attempts,
      lastAttemptAt: step.now,
      nextAttemptAt: new Date(
        step.now.getTime() + (step.awaiting ? awaitingBackoffMs(attempts) : backoffMs(attempts)),
      ),
      deliveryState: step.awaiting ? 'awaiting_reconciliation' : 'retrying',
      expectedNumber: step.awaiting ? step.expectedNumber : null,
      // The count of the authority belongs to the wait: a definite answer ends it.
      authorityLastAtMark: step.awaiting ? row.authorityLastAtMark : null,
      awaitingSince,
    })
    .where(eq(invoice.id, row.id));
  // A long wait is tried every few minutes: the first attempts are audited, then one for each hour.
  if (
    isAttemptAudited({ attempt: attempts, previousAttemptAt: row.lastAttemptAt, now: step.now })
  ) {
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
  if (awaitingSince) {
    await surfaceStall(tx, deps, row, { awaitingSince, now: step.now });
  } else {
    // A definite answer (the authority said it issued nothing): the doubt that held the series is over,
    // and an item that said so is closed. Whatever the invoice does next, it is not that one (JD-S4 R4-2).
    await settleStall(tx, deps, row.id, 'outcome_settled');
  }
}

/**
 * A series that waits for an invoice whose outcome stays unknown is not left to be found by chance:
 * once that invoice has waited for two hours, ONE worklist item is opened on it (JD-S4 R3-2). The item
 * does not say how many invoices wait: the count is live in the invoices (`blocksSeries`), where it is
 * also filtered by what the reader may see (JD-S4 R4-4). The invoice stays as it is; the item is
 * resolved when it settles. Nothing is opened for an invoice that holds nothing back, nor again for
 * one that a person already dismissed in this wait (JD-S4 R4-A-W3).
 */
async function surfaceStall(
  tx: Tx,
  deps: IssueDeps,
  row: InvoiceRow,
  step: { awaitingSince: Date; now: Date },
): Promise<void> {
  if (!deps.worklist) return;
  if (!isStalled({ awaitingSince: step.awaitingSince, now: step.now })) return;
  // Only the invoice that holds the series is the one to look at.
  const issuerCuit = row.issuerSnapshot?.cuit ?? '';
  if (await blockerInSeries(tx, row, issuerCuit)) return;
  const about = {
    kind: 'invoice_attention',
    subjectType: 'invoice',
    subjectId: row.id,
  } as const;
  // The item is there already, or a person dismissed it during this wait: nothing to open (and nothing
  // to encrypt and insert on every attempt).
  if (await deps.worklist.hasItem(tx, { ...about, status: 'open' })) return;
  if (
    await deps.worklist.hasItem(tx, { ...about, status: 'dismissed', since: step.awaitingSince })
  ) {
    return;
  }
  const [held] = await tx
    .select({ held: sql<number>`count(*)::int` })
    .from(invoice)
    .where(
      and(
        inSeries(row, issuerCuit),
        eq(invoice.status, 'pending'),
        ne(invoice.deliveryState, 'needs_attention'),
        ne(invoice.id, row.id),
      ),
    );
  if ((held?.held ?? 0) === 0) return;
  await deps.worklist.openItem(tx, {
    ...about,
    detail: {
      reason: 'outcome_unknown',
      type: row.type,
      pointOfSale: row.pointOfSale,
    },
  });
}

/**
 * The invoice left the wait (issued, rejected, parked, or told by the authority that nothing was
 * issued): the item that said its outcome is unknown is closed. It is called on every way out, whether
 * or not the attempt began as a wait: an item that is still open would be returned by the next
 * `openItem` and hide the real reason of whatever comes next (JD-S4 R4-2). `resolution` says how it
 * ended: `outcome_settled` when the doubt is over, `parked` when the invoice is parked with the doubt
 * still there (JD-S4 R4-A-T3).
 */
async function settleStall(
  tx: Tx,
  deps: IssueDeps,
  invoiceId: string,
  resolution: 'outcome_settled' | 'parked',
): Promise<void> {
  await deps.worklist?.closeBySubject(tx, {
    kind: 'invoice_attention',
    subjectType: 'invoice',
    subjectId: invoiceId,
    status: 'resolved',
    resolution,
    actor: { ...SYSTEM_ACTOR, userId: SYSTEM_USER_ID },
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
  // Whether the outcome of an earlier request was unknown when this attempt began: the invoice may
  // have an open item in the worklist that says so, and it is closed when the invoice settles.
  const wasAwaiting = found.deliveryState === 'awaiting_reconciliation';

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
      defer(tx, deps, row, {
        awaiting: row.deliveryState === 'awaiting_reconciliation',
        expectedNumber: row.expectedNumber,
        now,
      }),
    );
    return wrote ? 'retry' : 'skipped';
  }

  // The credential of a real authority follows the live fiscal profile, the request follows the issuer
  // the invoice was made with. If the organization changed its CUIT since, the two differ: the request
  // would be signed for one CUIT and name another. Nothing is sent; a person decides (JD-S4 R2-B-T5).
  if (!isSimulatedIssuer(issuer)) {
    const [credential] = await tx
      .select({ subjectCuit: fiscalCredential.subjectCuit })
      .from(fiscalCredential)
      .where(eq(fiscalCredential.active, true));
    if (credential && credential.subjectCuit !== snapshot.cuit) {
      const parked = await park(
        tx,
        deps,
        row,
        now,
        { number: null, cae: null, reason: 'issuer_mismatch' },
        wasAwaiting,
      );
      return parked ? 'attention' : 'skipped';
    }
  }

  // Another invoice of the series may have been answered without us knowing: its voucher is out
  // there under a number that this one would be expecting too. Nothing of the series is sent until
  // that one is settled (adopted, parked, replaced or sent again). Among two that both wait, the
  // older goes first. This one waits a minute and brings the other forward (JD-S4 R3-1).
  const blocker = await blockerInSeries(tx, row, snapshot.cuit);
  if (blocker) {
    await holdBack(tx, row, blocker, now);
    return 'skipped';
  }

  const step = { issuer: snapshot, tenantRef: organization.id };
  let verdict: Verdict | undefined;
  // The last number the authority had authorized when this request is sent: the voucher it may answer
  // with is above it.
  let floor: number | undefined;
  if (row.deliveryState === 'awaiting_reconciliation') {
    const reconciled = await reconcile(tx, issuer, row, step);
    if (reconciled.kind === 'send') floor = reconciled.floor;
    else verdict = reconciled;
  } else {
    // Nothing was sent yet. The authority is asked for its last number BEFORE the mark is written: an
    // authority that does not say it is not sent a request that could not be looked for afterwards.
    const answer = await askLastAuthorized(issuer, row, step);
    if (answer.status === 'ok') floor = answer.number;
    else verdict = { kind: 'retry', unknown: false };
  }
  if (!verdict) {
    if (floor === undefined) throw new Error('an attempt that sends has no last number');
    const marked = await markIntent(tx, deps, organization.id, row, { now, floor });
    // Closed since it was read, or its row is locked by someone else: the authority is not called.
    if (!marked) return 'skipped';
    row = marked;
    const request = await buildRequest(tx, row, snapshot, organization.id);
    verdict = await callAuthority(issuer, request, issuerKeyOf(organization.id, row.id));
  }

  if (verdict.kind === 'retry') {
    const { unknown } = verdict;
    const wrote = await lockedWrite(tx, row, () =>
      defer(tx, deps, row, {
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
          authorityLastAtMark: null,
          awaitingSince: null,
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
      await settleStall(tx, deps, row.id, 'outcome_settled');
    });
    return wrote ? 'rejected' : 'skipped';
  }

  if (verdict.kind === 'attention') {
    const wrote = await park(tx, deps, row, now, verdict, wasAwaiting);
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
            authorityLastAtMark: null,
            awaitingSince: null,
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
        await settleStall(inner, deps, row.id, 'outcome_settled');
        await settleAdoptedStrays(inner, deps, row, result, verdict.adoptedFrom ?? []);
      }),
    );
  } catch (error) {
    const reason = collisionOf(error);
    if (reason) {
      // The authority gave a number (or a CAE) that already belongs to one of our vouchers: a manual
      // entry, or the numbering of another environment. Trying again could issue another real
      // voucher each time: the invoice is parked for a person.
      const parked = await park(
        tx,
        deps,
        row,
        now,
        {
          number: result.number,
          cae: result.cae,
          reason,
          // The authority DID issue this voucher: it exists, and it cannot be recorded for anyone.
          stray: { number: result.number, reason: 'unmatched' },
        },
        wasAwaiting,
      );
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
 * The reasons for which parking an invoice does not settle whether the authority issued a voucher
 * for an earlier request: nothing was sent now (`issuer_mismatch`), the authority only showed that it
 * holds a voucher of somebody else where ours was expected (`voucher_mismatch`), or it holds one that
 * cannot be told from ours (`voucher_ambiguous`). With the others the authority DID issue a voucher for
 * the request, and it is the one that cannot be recorded; except when the lookup itself ended without
 * telling (`unresolved`: every number asked about was taken by another invoice).
 */
const UNKNOWN_OUTCOME_REASONS: readonly AttentionReason[] = [
  'issuer_mismatch',
  'voucher_mismatch',
  'voucher_ambiguous',
];

/** What the log says about each reason: never a message of the authority. */
const PARK_LOG: Record<AttentionReason, string> = {
  number_taken: 'an invoice needs attention: the authority issued a voucher with a number we hold',
  cae_taken: 'an invoice needs attention: the authority issued a voucher with a CAE we hold',
  voucher_mismatch:
    'an invoice needs attention: the authority holds a voucher where this invoice was expected that is not its own',
  issuer_mismatch:
    'an invoice needs attention: its issuer is not the one of the credential; nothing was sent',
  voucher_ambiguous:
    'an invoice needs attention: the authority holds a voucher that cannot be told from this invoice; nothing was sent',
};

/** The numbers in doubt of a verdict, as the audit entry and the worklist item say them (JD-S4 R5-A-F4). */
function inDoubt(found: NumbersInDoubt): NumbersInDoubt {
  return {
    ...(found.candidates ? { candidates: found.candidates } : {}),
    ...(found.candidatesFrom !== undefined ? { candidatesFrom: found.candidatesFrom } : {}),
    ...(found.candidatesTo !== undefined ? { candidatesTo: found.candidatesTo } : {}),
  };
}

/**
 * A voucher was adopted at a number that was remembered for other invoices (replaced or parked without
 * knowing whether they had been issued). Those invoices were not issued there: the voucher is this
 * invoice's. The item that told a person to look for it and cancel it in ARCA is closed (it would have
 * them cancel a valid voucher), and the audit trail names both invoices (JD-S4 R5-A-F5).
 */
async function settleAdoptedStrays(
  tx: Tx,
  deps: IssueDeps,
  row: InvoiceRow,
  result: Issued,
  strayInvoiceIds: readonly string[],
): Promise<void> {
  for (const strayInvoiceId of strayInvoiceIds) {
    await deps.worklist?.closeBySubject(tx, {
      kind: 'invoice_attention',
      subjectType: 'invoice',
      subjectId: strayInvoiceId,
      status: 'resolved',
      resolution: 'voucher_adopted_by_other',
      actor: { ...SYSTEM_ACTOR, userId: SYSTEM_USER_ID },
    });
    await audit(tx, {
      action: 'invoice.voucher_adopted',
      outcome: 'allow',
      actor: SYSTEM_ACTOR,
      resourceType: 'invoice',
      resourceId: row.id,
      ...(row.patientId ? { patientId: row.patientId } : {}),
      metadata: {
        type: row.type,
        pointOfSale: row.pointOfSale,
        number: result.number,
        strayInvoiceId,
      },
    });
  }
}

/**
 * Parks a pending invoice for a person: no automatic attempt touches it again. It writes the audit
 * entry, opens the worklist item and logs the number (never a message). Returns whether it wrote.
 *
 * `wasAwaiting` says that the invoice was waiting for reconciliation when the attempt began. If the
 * parking does not settle that doubt (`UNKNOWN_OUTCOME_REASONS`), the doubt is kept: the audit entry
 * and the item say `outcomeUnknown`, and the number expected stays on the row, so a replacement of
 * the invoice still needs the acknowledgement of the owner (JD-S4 R3-4). The item that said the
 * outcome was unknown is closed first, since the new reason takes its place.
 *
 * A voucher that exists and that no invoice can record, and the number where the voucher of an invoice
 * parked with a doubt may sit, are remembered (`recordStrayVoucher`), so that no later invoice adopts
 * the first as its own or counts on the second as free (JD-S4 R4-3).
 */
async function park(
  tx: Tx,
  deps: IssueDeps,
  row: InvoiceRow,
  now: Date,
  found: {
    number: number | null;
    cae: string | null;
    reason: AttentionReason;
    unresolved?: boolean | undefined;
    stray?: StrayToRemember | undefined;
  } & NumbersInDoubt,
  wasAwaiting: boolean,
): Promise<boolean> {
  const outcomeUnknown =
    wasAwaiting && (UNKNOWN_OUTCOME_REASONS.includes(found.reason) || found.unresolved === true);
  // The numbers a person looks at: the ones the lookup could not settle, or, when it did not look (the
  // issuer does not match), the number the invoice expected (JD-S4 R5-A-F4).
  const doubt: NumbersInDoubt =
    found.candidates || found.candidatesFrom !== undefined
      ? inDoubt(found)
      : outcomeUnknown && row.expectedNumber !== null
        ? { candidates: [row.expectedNumber] }
        : {};
  // Nothing was sent, so a doubt that was there stays: the voucher of the earlier request, if it exists,
  // sits at the number this invoice expected.
  const stray: StrayToRemember | undefined =
    found.stray ??
    (found.reason === 'issuer_mismatch' && outcomeUnknown && row.expectedNumber !== null
      ? { number: row.expectedNumber, reason: 'parked_unknown' }
      : undefined);
  const wrote = await lockedWrite(tx, row, async () => {
    await tx
      .update(invoice)
      .set({
        deliveryState: 'needs_attention',
        attempts: row.attempts + 1,
        lastAttemptAt: now,
        nextAttemptAt: null,
        expectedNumber: outcomeUnknown ? row.expectedNumber : null,
        // Kept with the doubt: it says from where a person looks for the voucher.
        authorityLastAtMark: outcomeUnknown ? row.authorityLastAtMark : null,
        awaitingSince: null,
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
        outcomeUnknown,
        ...doubt,
      },
    });
    if (stray) await recordStrayVoucher(tx, row.id, row, stray.number, stray.reason);
    // Every way out closes the item that said the outcome was unknown (even when the attempt did not
    // begin as a wait: an item that stayed open would be returned by the next one instead of the real
    // reason). The label says whether the doubt is over.
    await settleStall(tx, deps, row.id, outcomeUnknown ? 'parked' : 'outcome_settled');
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
        outcomeUnknown,
        ...doubt,
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
        outcomeUnknown,
      },
      PARK_LOG[found.reason],
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
  // The number stays known: no later invoice may take the voucher for its own (JD-S4 R3-3).
  await recordStrayVoucher(tx, row.id, row, result.number, 'orphaned');
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
