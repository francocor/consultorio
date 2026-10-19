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
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';
import { readPrescriberProfile } from '../../staff/index.js';
import {
  cleanProviderMessage,
  nextAttemptDelayMs,
  providerRequestOf,
} from '../domain/prescription.js';

import {
  SYSTEM_ACTOR,
  UNIQUE_VIOLATION,
  constraintOf,
  sqlState,
  type Organization,
  type PrescriptionDeps,
} from './common.js';
import { connectedProvider } from './connection.js';
import { storeDocument } from './document.js';
import { ERX_SUBMIT_JOB } from './job-names.js';
import { findPrescription, lockPrescription, openContent } from './read-model.js';

/**
 * What one attempt ended in. A `retry` keeps the prescription pending, with the next attempt
 * scheduled. `attention` means a person is needed (the matricula lost its verification, or the
 * provider holds a prescription that cannot be recorded for this one); `orphaned` means the
 * provider answered after the prescription was closed by someone else.
 */
export type SubmitOutcome = 'issued' | 'rejected' | 'retry' | 'skipped' | 'attention' | 'orphaned';

type AttentionReason =
  'matricula_unverified' | 'identifier_taken' | 'identifier_mismatch' | 'cancelled_at_provider';

type Issued = Extract<PrescriptionResult, { status: 'issued' }>;

type Verdict =
  | { kind: 'issued'; result: Issued; settled: ProviderPrescriptionState }
  | { kind: 'rejected'; message: string }
  /** `unknown`: the request may have been answered. Otherwise the provider said it issued nothing. */
  | { kind: 'retry'; unknown: boolean }
  /** A prescription the provider holds that cannot be recorded for this one, or a missing verification. */
  | { kind: 'attention'; reason: AttentionReason; externalId?: string };

export interface SubmitOptions {
  /** A person asked for it: the wait of the backoff and a parked prescription do not stop it. */
  force?: boolean;
  /** Who is acting (the professional of a request); the system by default. */
  actor?: AuditActor;
}

const UNREACHABLE: PrescriptionResult = {
  status: 'retryable',
  message: 'unreachable',
  outcomeUnknown: true,
};

/**
 * Writes down, BEFORE the provider is called, that it may answer this prescription: the row is
 * marked `awaiting_reconciliation`. If the process dies after the provider answered, the next
 * attempt finds the mark and asks the provider for the key before it sends anything. The mark is
 * committed on a connection of its own when there is one (`deps.withTenant`), so it does not wait for the end
 * of the attempt, which keeps its transaction open across the call. Only a definite answer clears it.
 */
async function markIntent(
  tx: Tx,
  deps: PrescriptionDeps,
  organization: Organization,
  row: PrescriptionRow,
  now: Date,
): Promise<void> {
  if (row.deliveryState === 'awaiting_reconciliation') return;
  const write = (target: Tx) =>
    target
      .update(prescription)
      .set({ deliveryState: 'awaiting_reconciliation', lastAttemptAt: now })
      .where(and(eq(prescription.id, row.id), eq(prescription.status, 'pending_submission')));
  if (deps.withTenant) {
    await deps.withTenant({ tenantId: organization.id, userId: SYSTEM_USER_ID }, async (own) => {
      await write(own);
    });
  } else {
    await write(tx);
  }
}

/** What the provider answered, or an unknown outcome when the call itself failed. */
async function callProvider(
  provider: PrescriptionProvider,
  request: PrescriptionRequest,
  key: string,
): Promise<Verdict> {
  // The same key always gets the same prescription, so asking again after a lost answer finds it.
  const result = await provider.issue(request, key).catch((): PrescriptionResult => UNREACHABLE);
  if (result.status === 'issued') return { kind: 'issued', result, settled: 'issued' };
  if (result.status === 'rejected') return { kind: 'rejected', message: result.message };
  return { kind: 'retry', unknown: result.outcomeUnknown };
}

/**
 * After an unknown outcome, or a crash, the provider is asked for the key BEFORE anything is sent
 * (design: "never issue blindly"). The answers:
 *
 * - it holds nothing for the key: the request goes out;
 * - it holds a prescription, and every identifying fact agrees (the identifier is the one it says
 *   it holds when asked by identifier, it is not cancelled, and no other prescription of ours
 *   already has it): it is adopted, and nothing is issued;
 * - it holds one that does not agree, or it does not answer: nothing is sent.
 */
async function reconcile(
  tx: Tx,
  provider: PrescriptionProvider,
  row: PrescriptionRow,
): Promise<Verdict | { kind: 'send' }> {
  const found = await provider
    .findByKey(row.idempotencyKey)
    .catch((): PrescriptionResult => UNREACHABLE);
  if (found === null) return { kind: 'send' };
  if (found.status === 'retryable') return { kind: 'retry', unknown: true };
  if (found.status === 'rejected') return { kind: 'rejected', message: found.message };

  const status: PrescriptionStatusResult = await provider
    .status(found.externalId)
    .catch((): PrescriptionStatusResult => ({ status: 'retryable', message: 'unreachable' }));
  if (status.status === 'retryable') return { kind: 'retry', unknown: true };
  if (status.status === 'unknown' || status.externalId !== found.externalId) {
    return { kind: 'attention', reason: 'identifier_mismatch', externalId: found.externalId };
  }
  if (status.state === 'cancelled') {
    return { kind: 'attention', reason: 'cancelled_at_provider', externalId: found.externalId };
  }
  const [other] = await tx
    .select({ id: prescription.id })
    .from(prescription)
    .where(and(eq(prescription.externalId, found.externalId), ne(prescription.id, row.id)))
    .limit(1);
  if (other) return { kind: 'attention', reason: 'identifier_taken', externalId: found.externalId };
  return { kind: 'issued', result: found, settled: status.state };
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
  },
): Promise<void> {
  const attempts = row.attempts + 1;
  const delay = nextAttemptDelayMs(attempts);
  await tx
    .update(prescription)
    .set({
      attempts,
      lastAttemptAt: step.now,
      nextAttemptAt: new Date(step.now.getTime() + delay),
      deliveryState: step.awaiting ? 'awaiting_reconciliation' : 'retrying',
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

/**
 * One attempt to get a pending prescription confirmed by the provider (e-prescription, "Provider
 * outage handling"). It is safe to run at any time and any number of times:
 *
 * - one attempt per prescription at a time (an advisory lock); a second caller skips;
 * - a prescription that is not pending, whose next attempt is not due, or that waits for a person, is
 *   left alone (unless a person asked: `force`); an organization that is read-only submits nothing;
 * - the matricula is checked AGAIN here: a registration that lost its verification since the
 *   prescription was made is not sent, it is parked;
 * - after an unknown outcome, or a crash, the provider is asked for the key BEFORE anything is sent,
 *   and a prescription it holds is adopted only when every identifying fact agrees. The mark that
 *   makes this possible is committed before every call (`markIntent`);
 * - a refusal is final for the attempt: the words of the provider are kept and the prescription
 *   becomes a draft that can be corrected;
 * - an outage or an unknown outcome keeps it pending with a longer wait each time, and queues the
 *   next attempt.
 *
 * The call to the provider is made without any row lock (the transaction of the caller stays open
 * across it, holding only the advisory lock); the row is locked only to write the answer.
 */
export async function attemptSubmit(
  tx: Tx,
  deps: PrescriptionDeps,
  prescriptionId: string,
  options: SubmitOptions = {},
): Promise<SubmitOutcome> {
  const now = deps.clock();
  const lock = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${'erx-prescription|' + prescriptionId}, 0)) as locked`,
  );
  if (lock.rows[0]?.locked !== true) return 'skipped';

  const row = await findPrescription(tx, prescriptionId);
  if (row?.status !== 'pending_submission') return 'skipped';
  if (!options.force) {
    if (row.deliveryState === 'needs_attention') return 'skipped';
    if (row.nextAttemptAt !== null && row.nextAttemptAt.getTime() > now.getTime()) return 'skipped';
  }

  const { provider, organization } = await connectedProvider(tx, deps);
  // A read-only or cancelled organization submits nothing (issuing is a write).
  if (!organization.active) return 'skipped';

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
    return wrote ? 'retry' : 'skipped';
  }

  // The verification is checked at the moment of issuing, every time the provider is about to be called.
  const profile = await readPrescriberProfile(tx, row.authorProfessionalId);
  if (profile?.status !== 'active' || profile.matriculaStatus !== 'verified') {
    return (await park(tx, deps, row, { now, reason: 'matricula_unverified' }))
      ? 'attention'
      : 'skipped';
  }

  const content = await openContent(deps.keys, tx, row);
  let verdict: Verdict | { kind: 'send' } | undefined;
  // Anything that may have reached the provider before (a mark, or any earlier attempt) is asked about first.
  if (row.deliveryState === 'awaiting_reconciliation' || row.lastAttemptAt !== null) {
    verdict = await reconcile(tx, provider, row);
  }
  if (verdict === undefined || verdict.kind === 'send') {
    await markIntent(tx, deps, organization, row, now);
    verdict = await callProvider(provider, providerRequestOf(content), row.idempotencyKey);
  }

  if (verdict.kind === 'retry') {
    const { unknown } = verdict;
    const wrote = await lockedWrite(tx, row, () =>
      defer(tx, deps, row, {
        awaiting: unknown,
        now,
        reason: 'unavailable',
        tenantId: organization.id,
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
