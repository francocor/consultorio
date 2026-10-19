import type {
  PrescriptionProvider,
  PrescriptionRequest,
  PrescriptionResult,
  PrescriptionStatusResult,
  ProviderPrescriptionState,
} from '@consultorio/contracts';
import { and, eq, ne, sql } from 'drizzle-orm';

import { prescription, type PrescriptionRow } from '../../../db/schema/prescriptions.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID, type Tx, type WithTenant } from '../../../platform/db/tenant-context.js';
import { readPrescriberProfile } from '../../staff/index.js';
import {
  cleanProviderMessage,
  nextAttemptDelayMs,
  providerRequestOf,
  type PrescriptionContent,
} from '../domain/prescription.js';

import {
  DEFAULT_IN_FLIGHT_PIN_MS,
  SYSTEM_ACTOR,
  UNIQUE_VIOLATION,
  UNREACHABLE,
  callWithin,
  constraintOf,
  sqlState,
  withinTime,
  type Organization,
  type PrescriptionDeps,
} from './common.js';
import { connectedProvider } from './connection.js';
import { storeDocument } from './document.js';
import { ERX_SUBMIT_JOB } from './job-names.js';
import { leaseIsLive, pinnedInFlight, releaseLease, takeLease } from './lease.js';
import { findPrescription, lockPrescription, openContent } from './read-model.js';

/**
 * What one attempt ended in. A `retry` keeps the prescription pending, with the next attempt
 * scheduled. `attention` means a person is needed (the matricula lost its verification or changed,
 * or the provider holds a prescription that cannot be recorded for this one); `orphaned` means the
 * provider answered after the prescription was closed by someone else.
 */
export type SubmitOutcome = 'issued' | 'rejected' | 'retry' | 'skipped' | 'attention' | 'orphaned';

type AttentionReason =
  | 'matricula_unverified'
  | 'matricula_changed'
  | 'identifier_taken'
  | 'identifier_mismatch'
  | 'cancelled_at_provider';

type Issued = Extract<PrescriptionResult, { status: 'issued' }>;

type Verdict =
  | { kind: 'issued'; result: Issued; settled: ProviderPrescriptionState }
  | { kind: 'rejected'; message: string }
  /**
   * `unknown`: the request may have been answered. Otherwise the provider said it issued nothing.
   * `timedOut`: the caller stopped waiting for a request that may still be running there.
   */
  | { kind: 'retry'; unknown: boolean; timedOut: boolean }
  /** A prescription the provider holds that cannot be recorded for this one, or a missing verification. */
  | { kind: 'attention'; reason: AttentionReason; externalId?: string };

export interface SubmitOptions {
  /** A person asked for it: the wait of the backoff and a parked prescription do not stop it. */
  force?: boolean;
  /** Who is acting (the professional of a request); the system by default. */
  actor?: AuditActor;
}

/**
 * Writes down, BEFORE the provider is called, that it may answer this prescription: the row is
 * marked `awaiting_reconciliation` and `provider_contacted_at` is set (it is never cleared, so a
 * prescription parked later is still asked about before it is cancelled or registered by hand). If
 * the process dies after the provider answered, the next attempt finds the mark and asks the
 * provider for the key before it sends anything. Only a definite answer clears the state.
 *
 * It answers whether the row was marked: a prescription somebody cancelled in the meantime is not
 * (the update touches only a row that still waits, also when it was marked before), and then NOTHING
 * is sent (JD-S5 R1-S5-3, R2-6).
 *
 * Where the mark is written: in the transaction given (`inTransaction`: the attempt of a request,
 * which holds no connection across the call and commits the mark before it), or, for an attempt that
 * keeps its transaction open across the call (a job), on a connection of its own so the mark does not
 * wait for the end of the attempt. That nested connection is acceptable only where few attempts run
 * at a time (the worker); no request may use it.
 */
async function markIntent(
  tx: Tx,
  deps: PrescriptionDeps,
  organization: Organization,
  row: PrescriptionRow,
  step: { now: Date; inTransaction: boolean },
): Promise<boolean> {
  // No shortcut for a row that is marked already: the update below is what checks, in the database,
  // that the prescription still waits (JD-S5 R2-6).
  const write = (target: Tx) =>
    target
      .update(prescription)
      .set({
        deliveryState: 'awaiting_reconciliation',
        lastAttemptAt: step.now,
        ...(row.providerContactedAt === null ? { providerContactedAt: step.now } : {}),
      })
      .where(and(eq(prescription.id, row.id), eq(prescription.status, 'pending_submission')))
      .returning({ id: prescription.id });
  const written =
    !step.inTransaction && deps.withTenant
      ? await deps.withTenant({ tenantId: organization.id, userId: SYSTEM_USER_ID }, write)
      : await write(tx);
  return written.length > 0;
}

/** What the provider answered, or an unknown outcome when the call itself failed or took too long. */
async function callProvider(
  deps: PrescriptionDeps,
  provider: PrescriptionProvider,
  request: PrescriptionRequest,
  key: string,
): Promise<Verdict> {
  // The same key always gets the same prescription, so asking again after a lost answer finds it.
  const { value: result, timedOut } = await callWithin(
    deps,
    (signal) => provider.issue(request, key, signal),
    UNREACHABLE,
  );
  if (result.status === 'issued') return { kind: 'issued', result, settled: 'issued' };
  if (result.status === 'rejected') return { kind: 'rejected', message: result.message };
  return { kind: 'retry', unknown: result.outcomeUnknown, timedOut };
}

/** What the provider says about the key of a prescription, before anything is sent. */
type Facts =
  | { kind: 'none' }
  | { kind: 'retry' }
  | { kind: 'rejected'; message: string }
  | { kind: 'attention'; reason: AttentionReason; externalId: string }
  | { kind: 'holds'; found: Issued; settled: ProviderPrescriptionState };

/**
 * After an unknown outcome, or a crash, the provider is asked for the key BEFORE anything is sent
 * (design: "never issue blindly"). This is the part that talks to the provider and needs no
 * transaction:
 *
 * - it holds nothing for the key: the request goes out;
 * - it holds a prescription, and every identifying fact agrees (the identifier is the one it says
 *   it holds when asked by identifier, and it is not cancelled): it is a candidate to be adopted;
 * - it holds one that does not agree, or it does not answer: nothing is sent.
 */
async function askAboutKey(
  deps: PrescriptionDeps,
  provider: PrescriptionProvider,
  row: PrescriptionRow,
): Promise<Facts> {
  const found = await withinTime(
    deps,
    (signal) => provider.findByKey(row.idempotencyKey, signal),
    UNREACHABLE,
  );
  if (found === null) return { kind: 'none' };
  if (found.status === 'retryable') return { kind: 'retry' };
  // A `rejected` answer to the question about a key is final: the provider refused that key for good.
  if (found.status === 'rejected') return { kind: 'rejected', message: found.message };

  const status: PrescriptionStatusResult = await withinTime(
    deps,
    (signal) => provider.status(found.externalId, signal),
    { status: 'retryable', message: 'unreachable' },
  );
  if (status.status === 'retryable') return { kind: 'retry' };
  if (status.status === 'unknown' || status.externalId !== found.externalId) {
    return { kind: 'attention', reason: 'identifier_mismatch', externalId: found.externalId };
  }
  if (status.state === 'cancelled') {
    return { kind: 'attention', reason: 'cancelled_at_provider', externalId: found.externalId };
  }
  return { kind: 'holds', found, settled: status.state };
}

/**
 * What the facts mean for this prescription: a prescription the provider holds is adopted only when
 * no other prescription of ours already has its identifier.
 */
async function conclude(
  tx: Tx,
  row: PrescriptionRow,
  facts: Facts,
): Promise<Verdict | { kind: 'send' }> {
  switch (facts.kind) {
    case 'none':
      return { kind: 'send' };
    case 'retry':
      return { kind: 'retry', unknown: true, timedOut: false };
    case 'rejected':
      return { kind: 'rejected', message: facts.message };
    case 'attention':
      return { kind: 'attention', reason: facts.reason, externalId: facts.externalId };
    case 'holds': {
      const [other] = await tx
        .select({ id: prescription.id })
        .from(prescription)
        .where(
          and(eq(prescription.externalId, facts.found.externalId), ne(prescription.id, row.id)),
        )
        .limit(1);
      if (other) {
        return {
          kind: 'attention',
          reason: 'identifier_taken',
          externalId: facts.found.externalId,
        };
      }
      return { kind: 'issued', result: facts.found, settled: facts.settled };
    }
  }
}

/**
 * Locks the row to write the answer and checks that it is still waiting: a prescription somebody
 * closed while the provider was being asked is left as it is, and the caller says what happened.
 */
async function lockedWrite(
  tx: Tx,
  row: PrescriptionRow,
  write: (locked: PrescriptionRow) => Promise<void>,
): Promise<boolean> {
  const locked = await lockPrescription(tx, row.id);
  if (locked?.status !== 'pending_submission') return false;
  await write(locked);
  return true;
}

/** Keeps the prescription pending and schedules the next attempt (a minute, doubling, up to an hour). */
async function defer(
  tx: Tx,
  deps: PrescriptionDeps,
  row: PrescriptionRow,
  step: {
    awaiting: boolean;
    now: Date;
    reason: 'unavailable' | 'provider_not_connected';
    tenantId: string;
    /** The call that failed timed out and may still be running at the provider (JD-S5 R2-3). */
    inFlight?: boolean;
  },
): Promise<void> {
  const attempts = row.attempts + 1;
  // A request that may still be running at the provider is not asked about before it can be done.
  const pin = deps.inFlightPinMs ?? DEFAULT_IN_FLIGHT_PIN_MS;
  const delay =
    step.inFlight === true
      ? Math.max(nextAttemptDelayMs(attempts), pin)
      : nextAttemptDelayMs(attempts);
  await tx
    .update(prescription)
    .set({
      attempts,
      lastAttemptAt: step.now,
      nextAttemptAt: new Date(step.now.getTime() + delay),
      deliveryState: step.awaiting ? 'awaiting_reconciliation' : 'retrying',
      ...(step.inFlight === true
        ? { providerInFlightUntil: new Date(step.now.getTime() + pin) }
        : {}),
    })
    .where(eq(prescription.id, row.id));
  await audit(tx, {
    action: 'prescription.failed',
    outcome: 'allow',
    actor: SYSTEM_ACTOR,
    resourceType: 'prescription',
    resourceId: row.id,
    patientId: row.patientId,
    reason: step.reason,
    metadata: { attempt: attempts, unknown: step.awaiting },
  });
  await deps.jobs?.enqueue(
    tx,
    ERX_SUBMIT_JOB,
    { tenantId: step.tenantId, prescriptionId: row.id },
    { startAfter: Math.ceil(delay / 1000) },
  );
}

/**
 * Parks a pending prescription for a person: no automatic attempt touches it again until somebody
 * presses retry. Writes the audit entry and logs the identifiers (never a message or a medication).
 * The mark that the provider may hold the prescription (`provider_contacted_at`) is not touched.
 */
async function park(
  tx: Tx,
  deps: PrescriptionDeps,
  row: PrescriptionRow,
  step: { now: Date; reason: AttentionReason },
): Promise<boolean> {
  const wrote = await lockedWrite(tx, row, async () => {
    await tx
      .update(prescription)
      .set({
        deliveryState: 'needs_attention',
        attempts: row.attempts + 1,
        lastAttemptAt: step.now,
        nextAttemptAt: null,
      })
      .where(eq(prescription.id, row.id));
    await audit(tx, {
      action: 'prescription.failed',
      outcome: 'allow',
      actor: SYSTEM_ACTOR,
      resourceType: 'prescription',
      resourceId: row.id,
      patientId: row.patientId,
      reason: step.reason,
      metadata: { attempt: row.attempts + 1 },
    });
  });
  if (wrote) {
    deps.log?.error(
      { prescriptionId: row.id, reason: step.reason },
      'a prescription needs attention: it cannot be sent or recorded as it is',
    );
  }
  return wrote;
}

/** Brings a prescription the provider already settled to the state it holds. */
async function applySettled(
  tx: Tx,
  row: PrescriptionRow,
  state: ProviderPrescriptionState,
): Promise<void> {
  if (state !== 'dispensed' && state !== 'expired') return;
  await tx.update(prescription).set({ status: state }).where(eq(prescription.id, row.id));
}

/** Everything the steps after the first one need to know about the attempt. */
interface Plan {
  row: PrescriptionRow;
  organization: Organization;
  provider: PrescriptionProvider;
  content: PrescriptionContent;
  /** The provider may have been asked about this prescription before: ask it about the key first. */
  ask: boolean;
  now: Date;
  /** The lease this attempt took (an attempt that holds no connection); only it can release it. */
  leaseToken: string | null;
}

type Begun = { done: SubmitOutcome } | { plan: Plan };

/**
 * Step 1 of an attempt: the gates, in a transaction. Nothing here talks to the provider.
 *
 * - one attempt per prescription at a time: the advisory lock for as long as this transaction
 *   lives, and, for an attempt that does not keep its transaction (`lease`), a lease on the row for
 *   the length of the call, so another attempt, a cancellation and a manual registration wait;
 * - a prescription that is not pending, whose next attempt is not due, or that waits for a person,
 *   is left alone (unless a person asked: `force`); an organization that is read-only submits nothing;
 * - the matricula is checked AGAIN here: a registration that lost its verification since the
 *   prescription was made, or whose number or jurisdiction is no longer the one the prescription
 *   says, is not sent, it is parked.
 */
async function begin(
  tx: Tx,
  deps: PrescriptionDeps,
  prescriptionId: string,
  options: SubmitOptions,
  mode: 'hold' | 'lease',
): Promise<Begun> {
  const now = deps.clock();
  const lock = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${'erx-prescription|' + prescriptionId}, 0)) as locked`,
  );
  if (lock.rows[0]?.locked !== true) return { done: 'skipped' };

  const row = await findPrescription(tx, prescriptionId);
  if (row?.status !== 'pending_submission') return { done: 'skipped' };
  // A call that timed out may still be running at the provider: not even a person can send again yet.
  if (pinnedInFlight(row, now)) return { done: 'skipped' };
  if (!options.force) {
    if (row.deliveryState === 'needs_attention') return { done: 'skipped' };
    if (row.nextAttemptAt !== null && row.nextAttemptAt.getTime() > now.getTime()) {
      return { done: 'skipped' };
    }
  }
  // Another attempt is waiting for the provider without a connection: it owns the row.
  if (leaseIsLive(row, now)) return { done: 'skipped' };

  const { provider, organization } = await connectedProvider(tx, deps);
  // A read-only or cancelled organization submits nothing (issuing is a write).
  if (!organization.active) return { done: 'skipped' };

  if (!provider) {
    // Nothing was sent, so nothing is learned: a mark from an earlier attempt stays.
    const wrote = await lockedWrite(tx, row, () =>
      defer(tx, deps, row, {
        awaiting: row.deliveryState === 'awaiting_reconciliation',
        now,
        reason: 'provider_not_connected',
        tenantId: organization.id,
      }),
    );
    return { done: wrote ? 'retry' : 'skipped' };
  }

  // The verification is checked at the moment of issuing, every time the provider is about to be called.
  const profile = await readPrescriberProfile(tx, row.authorProfessionalId);
  if (profile?.status !== 'active' || profile.matriculaStatus !== 'verified') {
    return {
      done: (await park(tx, deps, row, { now, reason: 'matricula_unverified' }))
        ? 'attention'
        : 'skipped',
    };
  }
  const content = await openContent(deps.keys, tx, row);
  // The registration the prescription says is the one the platform verified, not an older one the
  // professional had when it was made (the operator verified the NEW number, not the one on paper).
  if (
    content.prescriber.matricula !== profile.matricula ||
    content.prescriber.jurisdiction !== profile.jurisdiction
  ) {
    return {
      done: (await park(tx, deps, row, { now, reason: 'matricula_changed' }))
        ? 'attention'
        : 'skipped',
    };
  }

  const leaseToken = mode === 'lease' ? await takeLease(tx, row.id, now) : null;
  return {
    plan: {
      row,
      organization,
      provider,
      content,
      // Anything that may have reached the provider before (a mark, or any earlier attempt) is asked about first.
      ask:
        row.deliveryState === 'awaiting_reconciliation' ||
        row.lastAttemptAt !== null ||
        row.providerContactedAt !== null,
      now,
      leaseToken,
    },
  };
}

/**
 * The last step of an attempt: writes what the provider answered, in a transaction. A refusal is
 * final for the attempt (the words of the provider are kept and the prescription becomes a draft that
 * can be corrected); an outage or an unknown outcome keeps it pending with a longer wait each time
 * and queues the next attempt.
 */
async function settle(
  tx: Tx,
  deps: PrescriptionDeps,
  plan: Plan,
  verdict: Verdict,
  options: SubmitOptions,
  step: { releaseLease: boolean },
): Promise<SubmitOutcome> {
  const { row, organization, now } = plan;
  // Only the lease of THIS attempt is released: one that overran and finds another attempt in charge
  // leaves that attempt's lease alone (JD-S5 R2-7).
  if (step.releaseLease && plan.leaseToken !== null) {
    await releaseLease(tx, row.id, plan.leaseToken);
  }

  if (verdict.kind === 'retry') {
    const { unknown, timedOut } = verdict;
    const wrote = await lockedWrite(tx, row, () =>
      defer(tx, deps, row, {
        awaiting: unknown,
        now,
        reason: 'unavailable',
        tenantId: organization.id,
        inFlight: timedOut,
      }),
    );
    return wrote ? 'retry' : 'skipped';
  }

  if (verdict.kind === 'attention') {
    return (await park(tx, deps, row, { now, reason: verdict.reason })) ? 'attention' : 'skipped';
  }

  if (verdict.kind === 'rejected') {
    const { message } = verdict;
    const wrote = await lockedWrite(tx, row, async () => {
      await tx
        .update(prescription)
        .set({
          status: 'draft',
          deliveryState: null,
          rejectionMessage: cleanProviderMessage(message),
          attempts: row.attempts + 1,
          lastAttemptAt: now,
          nextAttemptAt: null,
        })
        .where(eq(prescription.id, row.id));
      await audit(tx, {
        action: 'prescription.failed',
        outcome: 'allow',
        actor: SYSTEM_ACTOR,
        resourceType: 'prescription',
        resourceId: row.id,
        patientId: row.patientId,
        reason: 'rejected',
        metadata: { attempt: row.attempts + 1 },
      });
    });
    return wrote ? 'rejected' : 'skipped';
  }

  const { result, settled } = verdict;
  let wrote: boolean;
  try {
    // A savepoint: an identifier that is already registered must not abort the whole attempt.
    wrote = await tx.transaction((inner) =>
      lockedWrite(inner, row, async () => {
        await inner
          .update(prescription)
          .set({
            status: 'issued',
            externalId: result.externalId,
            issuedAt: now,
            deliveryState: null,
            rejectionMessage: null,
            attempts: row.attempts + 1,
            lastAttemptAt: now,
            nextAttemptAt: null,
          })
          .where(eq(prescription.id, row.id));
        await applySettled(inner, row, settled);
        await audit(inner, {
          action: 'prescription.issued',
          outcome: 'allow',
          actor: options.actor ?? SYSTEM_ACTOR,
          resourceType: 'prescription',
          resourceId: row.id,
          patientId: row.patientId,
          metadata: { simulated: row.simulated, attempt: row.attempts + 1, via: 'provider' },
        });
      }),
    );
  } catch (error) {
    if (
      sqlState(error) === UNIQUE_VIOLATION &&
      constraintOf(error) === 'prescription_external_key'
    ) {
      // The provider gave an identifier that already belongs to another prescription of ours: trying
      // again could issue another real one each time, so a person decides.
      return (await park(tx, deps, row, { now, reason: 'identifier_taken' }))
        ? 'attention'
        : 'skipped';
    }
    throw error;
  }
  if (!wrote) {
    // Another attempt (one that took the row over) recorded this very prescription first: nothing is
    // lost and nothing is orphaned.
    const current = await findPrescription(tx, row.id);
    if (current?.externalId === result.externalId) return 'skipped';
    // The provider issued a prescription that no longer waits: somebody closed it while the request
    // was in flight. It exists and nothing records it: say so loudly.
    await audit(tx, {
      action: 'prescription.failed',
      outcome: 'allow',
      actor: SYSTEM_ACTOR,
      resourceType: 'prescription',
      resourceId: row.id,
      patientId: row.patientId,
      reason: 'orphaned',
      metadata: { attempt: row.attempts + 1 },
    });
    deps.log?.error(
      { prescriptionId: row.id },
      'a prescription was issued by the provider after it was closed here',
    );
    return 'orphaned';
  }

  // The document is made now so the first download is quick; if it cannot be, a download makes it.
  try {
    await tx.transaction((inner) => storeDocument(inner, deps, row.id));
  } catch (error) {
    deps.log?.error(
      { prescriptionId: row.id, code: sqlState(error) ?? 'unknown' },
      'the document of a prescription could not be made',
    );
  }
  return 'issued';
}

/**
 * One attempt to get a pending prescription confirmed by the provider (e-prescription, "Provider
 * outage handling"), for a caller that has a transaction and keeps it open across the call: the job
 * of the worker and the reconciliation pass. It is safe to run at any time and any number of times.
 *
 * - the steps are `begin` (gates), the question about the key, the mark, the call, and `settle`;
 * - after an unknown outcome, or a crash, the provider is asked for the key BEFORE anything is sent,
 *   and a prescription it holds is adopted only when every identifying fact agrees. The mark that
 *   makes this possible is committed before every call (`markIntent`), and a prescription somebody
 *   cancelled meanwhile is not sent at all;
 * - the call to the provider is made without any row lock (the transaction of the caller stays open
 *   across it, holding only the advisory lock); the row is locked only to write the answer.
 *
 * A request must use `attemptSubmitDetached`: it never holds a connection while it waits.
 */
export async function attemptSubmit(
  tx: Tx,
  deps: PrescriptionDeps,
  prescriptionId: string,
  options: SubmitOptions = {},
): Promise<SubmitOutcome> {
  const begun = await begin(tx, deps, prescriptionId, options, 'hold');
  if ('done' in begun) return begun.done;
  const { plan } = begun;

  let verdict: Verdict | { kind: 'send' } = plan.ask
    ? await conclude(tx, plan.row, await askAboutKey(deps, plan.provider, plan.row))
    : { kind: 'send' };
  if (verdict.kind === 'send') {
    if (
      !(await markIntent(tx, deps, plan.organization, plan.row, {
        now: plan.now,
        inTransaction: false,
      }))
    ) {
      return 'skipped';
    }
    verdict = await callProvider(
      deps,
      plan.provider,
      providerRequestOf(plan.content),
      plan.row.idempotencyKey,
    );
  }
  return settle(tx, deps, plan, verdict, options, { releaseLease: false });
}

/**
 * The same attempt for a caller that must not hold a connection while the provider is being waited
 * for: the request of a professional (JD-S5 R1-S5-1). Each step that touches the database runs in a
 * short transaction of its own and commits before the next call to the provider, so a pool of ten
 * connections serves any number of concurrent requests: no request holds one connection and waits
 * for another. The mark is committed before the call, as always, and the row is leased for the
 * length of the attempt (`attempt_lease_until`) so nothing else touches it meanwhile; a crash leaves
 * a lease that runs out.
 *
 * It runs as the system, like the job: the authorization of the person who asked was decided by the
 * route before it, and `options.actor` is who the trail names.
 */
export async function attemptSubmitDetached(
  deps: PrescriptionDeps & { withTenant: WithTenant },
  tenantId: string,
  prescriptionId: string,
  options: SubmitOptions = {},
): Promise<SubmitOutcome> {
  const as = <T>(work: (tx: Tx) => Promise<T>) =>
    deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, work);
  const release = (token: string | null) =>
    token === null
      ? Promise.resolve()
      : as((tx) => releaseLease(tx, prescriptionId, token)).then(() => undefined);

  const begun = await as((tx) => begin(tx, deps, prescriptionId, options, 'lease'));
  if ('done' in begun) return begun.done;
  const { plan } = begun;

  try {
    let verdict: Verdict | { kind: 'send' };
    if (plan.ask) {
      const facts = await askAboutKey(deps, plan.provider, plan.row);
      verdict = await as((tx) => conclude(tx, plan.row, facts));
    } else {
      verdict = { kind: 'send' };
    }
    if (verdict.kind === 'send') {
      const marked = await as((tx) =>
        markIntent(tx, deps, plan.organization, plan.row, { now: plan.now, inTransaction: true }),
      );
      if (!marked) {
        await release(plan.leaseToken);
        return 'skipped';
      }
      verdict = await callProvider(
        deps,
        plan.provider,
        providerRequestOf(plan.content),
        plan.row.idempotencyKey,
      );
    }
    const decided = verdict;
    return await as((tx) => settle(tx, deps, plan, decided, options, { releaseLease: true }));
  } catch (error) {
    await release(plan.leaseToken).catch(() => undefined);
    throw error;
  }
}
