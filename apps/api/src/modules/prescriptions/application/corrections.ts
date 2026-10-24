import type {
  CancelPrescriptionRequest,
  PrescriptionCancelResult,
  PrescriptionProvider,
  RegisterManualPrescriptionRequest,
} from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';

import { prescription, type PrescriptionRow } from '../../../db/schema/prescriptions.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { readPrescriberProfile } from '../../staff/index.js';
import { cancelKeyOf } from '../domain/prescription.js';

import {
  CANCEL_REASON_FIELD,
  UNIQUE_VIOLATION,
  UNREACHABLE,
  callWithin,
  constraintOf,
  sqlState,
  withinTime,
  type Organization,
  type PrescriptionDeps,
} from './common.js';
import { connectedProvider, requireProvider } from './connection.js';
import { PrescriptionConflict, PrescriptionDenied } from './errors.js';
import type { Caller } from './issue.js';
import { leaseIsLive, pinnedInFlight, releaseLease, takeLease } from './lease.js';
import { hiddenOrMissing, lockPrescription } from './read-model.js';

/**
 * What cancelling ended in. A refusal and an outage are answered AFTER the transaction commits (the
 * route throws), so the entry of the audit trail that says the provider refused is not rolled back
 * with the request.
 */
export type CancelOutcome = 'cancelled' | 'refused' | 'unavailable';

/**
 * Runs a step in a transaction of its own, as the professional who asked. The cancellation and the
 * manual registration ask the provider BETWEEN two such steps, so a request never holds a connection
 * or the lock of the row while the provider is waited for (JD-S5 R2-12). A caller that only has a
 * transaction (the demo seed) passes `inTransaction(tx)`: the steps then run in that one.
 */
export type RunAs = <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;

export const inTransaction =
  (tx: Tx): RunAs =>
  (work) =>
    work(tx);

/** The prescriber is the one who cancels; a colleague who treats the patient reads and is refused. */
function entryOf(row: PrescriptionRow) {
  return { prescriptionId: row.id, patientId: row.patientId };
}

const inProgress = (row: PrescriptionRow) =>
  new PrescriptionConflict(
    'prescription_attempt_in_progress',
    'prescription_attempt_in_progress',
    entryOf(row),
  );

const inFlight = (row: PrescriptionRow) =>
  new PrescriptionConflict(
    'prescription_provider_in_flight',
    'prescription_provider_in_flight',
    entryOf(row),
  );

/**
 * Leaves the row alone while an attempt waits for the provider: the advisory lock of the attempts
 * (held for the length of a job's transaction), the lease of a request's attempt (which holds no
 * connection) and the pin of a call that timed out (it may still be running at the provider, JD-S5
 * R2-3) all mean "somebody is sending this". The same advisory lock as `attemptSubmit`'s, and a
 * try-lock: it answers a conflict at once instead of waiting.
 */
async function assertNoAttemptInFlight(
  tx: Tx,
  deps: PrescriptionDeps,
  row: PrescriptionRow,
): Promise<void> {
  const lock = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtextextended(${'erx-prescription|' + row.id}, 0)) as locked`,
  );
  const now = deps.clock();
  if (lock.rows[0]?.locked !== true || leaseIsLive(row, now)) throw inProgress(row);
  // A send is in flight at the provider: it is a matter of minutes, not of seconds (JD-S5 R3).
  if (pinnedInFlight(row, now)) throw inFlight(row);
}

/**
 * Whether the provider may hold a prescription for this row: it was asked to issue it (the mark is
 * never cleared, whatever state the row was parked in since), the answer was lost, or the row says an
 * attempt was made although it carries no mark (a row from before the marks: `last_attempt_at` is
 * what has always told that an attempt was made, JD-S5 R2-10). A refused draft holds nothing: the
 * provider said so.
 */
function mayHoldAtProvider(row: PrescriptionRow): boolean {
  return (
    row.status === 'pending_submission' &&
    (row.providerContactedAt !== null ||
      row.lastAttemptAt !== null ||
      row.deliveryState === 'awaiting_reconciliation')
  );
}

/** What the provider says about the key of a row that may have reached it. No transaction is open. */
async function askProvider(
  deps: PrescriptionDeps,
  provider: PrescriptionProvider,
  row: PrescriptionRow,
): Promise<'free' | 'holds' | 'unreachable'> {
  const found = await withinTime(
    deps,
    (signal) => provider.findByKey(row.idempotencyKey, signal),
    UNREACHABLE,
  );
  if (found === null || found.status === 'rejected') return 'free';
  return found.status === 'retryable' ? 'unreachable' : 'holds';
}

async function writeCancelled(
  tx: Tx,
  deps: PrescriptionDeps,
  caller: Caller,
  row: PrescriptionRow,
  step: { reason: string; via: 'provider' | 'local'; unconfirmed?: boolean },
): Promise<void> {
  const blob = await deps.keys.encryptField(
    tx,
    { ...CANCEL_REASON_FIELD, rowId: row.id },
    step.reason,
  );
  await tx
    .update(prescription)
    .set({
      status: 'cancelled',
      cancelReasonEnc: blob,
      cancelledAt: deps.clock(),
      deliveryState: null,
      nextAttemptAt: null,
      version: row.version + 1,
    })
    .where(eq(prescription.id, row.id));
  await audit(tx, {
    action: 'prescription.cancelled',
    outcome: 'allow',
    actor: caller.actor,
    resourceType: 'prescription',
    resourceId: row.id,
    patientId: row.patientId,
    metadata: {
      via: step.via,
      status: row.status,
      // Closed here although the provider may hold it, because no provider was there to ask.
      ...(step.unconfirmed === true ? { unconfirmed: true } : {}),
    },
  });
}

/**
 * The row again, after the provider was asked, if this request still owns it: the lease it took is
 * the one on the row AND it is still alive (JD-S5 R3-8). A lease that ran out, whether or not
 * another attempt took it over, means this request no longer holds the row, and it does nothing
 * more: the provider is asked again by whoever acts next.
 */
async function ownedRow(
  tx: Tx,
  deps: PrescriptionDeps,
  row: PrescriptionRow,
  token: string,
): Promise<PrescriptionRow | undefined> {
  const locked = await lockPrescription(tx, row.id);
  if (locked?.attemptLeaseToken !== token) return undefined;
  if (!leaseIsLive(locked, deps.clock())) return undefined;
  return locked;
}

/**
 * Cancels a prescription with a mandatory reason (e-prescription, "Immutability and cancellation"):
 *
 * - an issued prescription is cancelled THROUGH the provider; if the provider refuses, it stays
 *   issued and the refusal is audited; if the provider cannot be reached, nothing changes and the
 *   same request can be sent again (the cancellation key is the same, so the answer is the same);
 * - one the provider never confirmed (an outage, or a refusal) is cancelled here, without calling
 *   anybody, unless the provider may have issued it and the answer is unknown: it is asked first;
 * - anything else (dispensed, expired, already cancelled) stays as it is.
 *
 * The provider is asked WITHOUT a transaction (JD-S5 R2-12): a first step takes the row and the lease
 * and commits, the question to the provider is made with nothing held, and a last short step writes
 * the answer and lets the lease go. The lease keeps an attempt, a second cancellation and a manual
 * registration away from the row meanwhile.
 *
 * The reason is encrypted like the rest of the prescription and never reaches the audit trail.
 */
export async function cancelPrescriptionPhased(
  run: RunAs,
  deps: PrescriptionDeps,
  caller: Caller,
  input: { prescriptionId: string; request: CancelPrescriptionRequest },
): Promise<CancelOutcome> {
  const { reason } = input.request;

  type Begun =
    | { kind: 'done' }
    | { kind: 'ask'; row: PrescriptionRow; provider: PrescriptionProvider; token: string }
    | {
        kind: 'cancel';
        row: PrescriptionRow;
        provider: PrescriptionProvider;
        organization: Organization;
        token: string;
      };
  const begun = await run(async (tx): Promise<Begun> => {
    const row = await lockPrescription(tx, input.prescriptionId);
    if (!row) return hiddenOrMissing(tx, input.prescriptionId);
    if (row.authorProfessionalId !== caller.professionalId) {
      throw new PrescriptionDenied('prescription_not_author', entryOf(row));
    }
    if (row.status === 'pending_submission' || row.status === 'draft') {
      // Not while an attempt is waiting for the provider (JD-S5 R1-S5-3): the provider would be given
      // a prescription that was cancelled here a moment ago.
      await assertNoAttemptInFlight(tx, deps, row);
      if (!mayHoldAtProvider(row)) {
        await writeCancelled(tx, deps, caller, row, { reason, via: 'local' });
        return { kind: 'done' };
      }
      // The provider may hold it even if this row says otherwise (a parked row, a lost answer): it
      // is asked first, and a prescription it holds is cancelled after it is recorded, not here.
      const { provider } = await connectedProvider(tx, deps);
      if (!provider) {
        // Nobody to ask. The professional may close it knowing so (JD-S5 R2, B-T7); otherwise the
        // prescription waits for a provider to be connected.
        if (input.request.acknowledgeUnknownOutcome !== true) {
          throw new AppError('prescription_provider_not_connected');
        }
        await writeCancelled(tx, deps, caller, row, { reason, via: 'local', unconfirmed: true });
        return { kind: 'done' };
      }
      return { kind: 'ask', row, provider, token: await takeLease(tx, row.id, deps.clock()) };
    }
    if (row.status !== 'issued' || row.externalId === null) {
      throw new PrescriptionConflict(
        'prescription_not_cancellable',
        'prescription_not_cancellable',
        entryOf(row),
      );
    }
    const { provider, organization } = await requireProvider(tx, deps);
    await assertNoAttemptInFlight(tx, deps, row);
    return {
      kind: 'cancel',
      row,
      provider,
      organization,
      token: await takeLease(tx, row.id, deps.clock()),
    };
  });
  if (begun.kind === 'done') return 'cancelled';

  if (begun.kind === 'ask') {
    const { row, token } = begun;
    const answer = await askProvider(deps, begun.provider, row);
    const ended = await run(async (tx) => {
      const locked = await ownedRow(tx, deps, row, token);
      if (!locked) return 'lost' as const;
      await releaseLease(tx, row.id, token);
      if (answer === 'unreachable') return 'unavailable' as const;
      if (answer === 'holds') return 'holds' as const;
      if (locked.status !== 'pending_submission' && locked.status !== 'draft') {
        return 'changed' as const;
      }
      await writeCancelled(tx, deps, caller, locked, { reason, via: 'local' });
      return 'cancelled' as const;
    });
    if (ended === 'unavailable' || ended === 'cancelled') return ended;
    if (ended === 'holds') {
      throw new PrescriptionConflict(
        'prescription_awaiting_reconciliation',
        'prescription_awaiting_reconciliation',
        entryOf(row),
      );
    }
    if (ended === 'lost') throw inProgress(row);
    throw new PrescriptionConflict(
      'prescription_not_cancellable',
      'prescription_not_cancellable',
      entryOf(row),
    );
  }

  const { row, token, provider, organization } = begun;
  const externalId = row.externalId ?? '';
  const { value: result } = await callWithin<PrescriptionCancelResult>(
    deps,
    (signal) => provider.cancel(externalId, reason, cancelKeyOf(organization.id, row.id), signal),
    { status: 'retryable', message: 'unreachable', outcomeUnknown: true },
  );
  const ended = await run(async (tx) => {
    const locked = await ownedRow(tx, deps, row, token);
    if (!locked) return 'lost' as const;
    await releaseLease(tx, row.id, token);
    if (result.status === 'cancelled') {
      // Recorded unless somebody settled it meanwhile (a notice of the provider): then it already says so.
      if (locked.status === 'issued') {
        await writeCancelled(tx, deps, caller, locked, { reason, via: 'provider' });
      }
      return 'cancelled' as const;
    }
    await audit(tx, {
      action: 'prescription.failed',
      outcome: 'allow',
      actor: caller.actor,
      resourceType: 'prescription',
      resourceId: row.id,
      patientId: row.patientId,
      reason: result.status === 'rejected' ? 'cancel_refused' : 'cancel_unavailable',
      metadata: { operation: 'cancel' },
    });
    return result.status === 'rejected' ? ('refused' as const) : ('unavailable' as const);
  });
  if (ended === 'lost') throw inProgress(row);
  return ended;
}

/** The same cancellation for a caller that has one transaction (the seed of the demonstration). */
export function cancelPrescription(
  tx: Tx,
  deps: PrescriptionDeps,
  caller: Caller,
  input: { prescriptionId: string; request: CancelPrescriptionRequest },
): Promise<CancelOutcome> {
  return cancelPrescriptionPhased(inTransaction(tx), deps, caller, input);
}

/** Issued by hand: the identifier typed in, the prescription recorded as issued and flagged. */
async function writeRegistered(
  tx: Tx,
  caller: Caller,
  row: PrescriptionRow,
  input: { identifier: string; now: Date; unconfirmed?: boolean },
): Promise<'registered' | 'taken'> {
  try {
    // A savepoint: an identifier that is already registered must not abort the whole request.
    await tx.transaction(async (inner) => {
      // A refused draft goes back to waiting before it can be issued (the database allows no shortcut).
      if (row.status === 'draft') {
        await inner
          .update(prescription)
          .set({ status: 'pending_submission', rejectionMessage: null })
          .where(eq(prescription.id, row.id));
      }
      await inner
        .update(prescription)
        .set({
          status: 'issued',
          externalId: input.identifier,
          issuedAt: input.now,
          registeredManually: true,
          deliveryState: null,
          nextAttemptAt: null,
          version: row.version + 1,
        })
        .where(eq(prescription.id, row.id));
    });
  } catch (error) {
    if (
      sqlState(error) === UNIQUE_VIOLATION &&
      constraintOf(error) === 'prescription_external_key'
    ) {
      return 'taken';
    }
    throw error;
  }
  await audit(tx, {
    action: 'prescription.registered_manually',
    outcome: 'allow',
    actor: caller.actor,
    resourceType: 'prescription',
    resourceId: row.id,
    patientId: row.patientId,
    metadata: {
      simulated: row.simulated,
      // Registered although the provider may hold the prescription, because no provider was there to
      // ask (the professional acknowledged it).
      ...(input.unconfirmed === true ? { unconfirmed: true } : {}),
    },
  });
  return 'registered';
}

/**
 * Registers the identifier of a prescription the professional issued directly on the provider's own
 * site (e-prescription, "Manual fallback registration"): it is stored as issued and flagged
 * "registered manually". It applies to a prescription the provider has not confirmed; one whose
 * answer may be lost waits until the provider has been asked, so the same prescription is never
 * issued twice. Like the cancellation, the provider is asked between two short transactions
 * (JD-S5 R2-12).
 */
export async function registerManuallyPhased(
  run: RunAs,
  deps: PrescriptionDeps,
  caller: Caller,
  input: { prescriptionId: string; request: RegisterManualPrescriptionRequest },
): Promise<void> {
  const { identifier } = input.request;

  type Begun =
    | { kind: 'done' }
    | { kind: 'ask'; row: PrescriptionRow; provider: PrescriptionProvider; token: string };
  const begun = await run(async (tx): Promise<Begun> => {
    const row = await lockPrescription(tx, input.prescriptionId);
    if (!row) return hiddenOrMissing(tx, input.prescriptionId);
    if (row.authorProfessionalId !== caller.professionalId) {
      throw new PrescriptionDenied('prescription_not_author', entryOf(row));
    }
    if (row.status !== 'pending_submission' && row.status !== 'draft') {
      throw new AppError('prescription_not_pending');
    }
    await assertNoAttemptInFlight(tx, deps, row);
    // The identifier is typed by a person and ends on a document: the registration that vouches for it
    // is checked again now, not only when the prescription was made (JD-S5 R1-A-T5).
    const profile = await readPrescriberProfile(tx, caller.professionalId);
    if (profile?.status !== 'active' || profile.matriculaStatus !== 'verified') {
      throw new AppError('prescription_matricula_unverified');
    }
    if (!mayHoldAtProvider(row)) {
      if ((await writeRegistered(tx, caller, row, { identifier, now: deps.clock() })) === 'taken') {
        throw new AppError('prescription_identifier_taken');
      }
      return { kind: 'done' };
    }
    const { provider } = await connectedProvider(tx, deps);
    if (!provider) {
      // Nobody to ask. The professional may register it knowing so (the same acknowledgement as the
      // cancellation); otherwise the prescription waits for a provider to be connected.
      if (input.request.acknowledgeUnknownOutcome !== true) {
        throw new AppError('prescription_provider_not_connected');
      }
      const written = await writeRegistered(tx, caller, row, {
        identifier,
        now: deps.clock(),
        unconfirmed: true,
      });
      if (written === 'taken') throw new AppError('prescription_identifier_taken');
      return { kind: 'done' };
    }
    return { kind: 'ask', row, provider, token: await takeLease(tx, row.id, deps.clock()) };
  });
  if (begun.kind === 'done') return;

  const { row, token } = begun;
  const answer = await askProvider(deps, begun.provider, row);
  const ended = await run(async (tx) => {
    const locked = await ownedRow(tx, deps, row, token);
    if (!locked) return 'lost' as const;
    await releaseLease(tx, row.id, token);
    if (answer === 'unreachable') return 'unavailable' as const;
    if (answer === 'holds') return 'holds' as const;
    if (locked.status !== 'pending_submission' && locked.status !== 'draft') {
      return 'changed' as const;
    }
    return writeRegistered(tx, caller, locked, { identifier, now: deps.clock() });
  });
  if (ended === 'registered') return;
  if (ended === 'lost') throw inProgress(row);
  if (ended === 'unavailable') throw new AppError('prescription_provider_unavailable');
  if (ended === 'holds') throw new AppError('prescription_awaiting_reconciliation');
  if (ended === 'taken') throw new AppError('prescription_identifier_taken');
  throw new AppError('prescription_not_pending');
}

/** The same registration for a caller that has one transaction. */
export function registerManually(
  tx: Tx,
  deps: PrescriptionDeps,
  caller: Caller,
  input: { prescriptionId: string; request: RegisterManualPrescriptionRequest },
): Promise<void> {
  return registerManuallyPhased(inTransaction(tx), deps, caller, input);
}
