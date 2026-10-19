import type { PrescriptionStatusResult } from '@consultorio/contracts';
import { and, asc, eq, gt, inArray, isNull, lt, lte, or } from 'drizzle-orm';

import { prescription } from '../../../db/schema/prescriptions.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import { CANCEL_REASON_FIELD, SYSTEM_ACTOR, sqlState, type PrescriptionDeps } from './common.js';
import { connectedProvider } from './connection.js';
import { findPrescription, lockPrescription } from './read-model.js';
import { attemptSubmit, type SubmitOutcome } from './submit.js';

export type SettleOutcome =
  'unchanged' | 'dispensed' | 'expired' | 'cancelled' | 'skipped' | 'unavailable';

/** What the provider says when a prescription was cancelled on its side and gave no reason. */
const CANCELLED_AT_PROVIDER = 'Anulada en el sitio del proveedor.';

/** How long an issued prescription is looked at: past this it is long expired, whatever it says. */
const WATCH_DAYS = 120;
/** How often an issued prescription is asked about when no notice arrives. */
const CHECK_EVERY_MS = 10 * 60_000;
/** Most prescriptions one pass of an organization looks at. */
const BATCH = 50;

/**
 * Brings an issued prescription to the state the provider says it is in (dispensed, expired,
 * cancelled on its side), as the provider reports it. The provider is the authority: a notice only
 * tells us to ask, and an answer that cannot be obtained changes nothing. A prescription registered
 * by hand that the provider does not know stays as the professional registered it.
 */
export async function settleFromProvider(
  tx: Tx,
  deps: PrescriptionDeps,
  prescriptionId: string,
): Promise<SettleOutcome> {
  const probe = await findPrescription(tx, prescriptionId);
  if (probe?.status !== 'issued' || probe.externalId === null) return 'skipped';
  const { provider } = await connectedProvider(tx, deps);
  if (!provider) return 'skipped';

  const status: PrescriptionStatusResult = await provider
    .status(probe.externalId)
    .catch((): PrescriptionStatusResult => ({ status: 'retryable', message: 'unreachable' }));
  if (status.status === 'retryable') return 'unavailable';

  const row = await lockPrescription(tx, prescriptionId);
  if (row?.status !== 'issued') return 'skipped';
  const now = deps.clock();
  if (status.status === 'unknown' || status.state === 'issued') {
    await tx.update(prescription).set({ lastCheckedAt: now }).where(eq(prescription.id, row.id));
    return 'unchanged';
  }

  if (status.state === 'dispensed' || status.state === 'expired') {
    await tx
      .update(prescription)
      .set({ status: status.state, lastCheckedAt: now, version: row.version + 1 })
      .where(eq(prescription.id, row.id));
    return status.state;
  }

  // Cancelled on the side of the provider (another channel): it keeps the reason the provider gave.
  const blob = await deps.keys.encryptField(
    tx,
    { ...CANCEL_REASON_FIELD, rowId: row.id },
    status.cancelReason ?? CANCELLED_AT_PROVIDER,
  );
  await tx
    .update(prescription)
    .set({
      status: 'cancelled',
      cancelReasonEnc: blob,
      cancelledAt: now,
      lastCheckedAt: now,
      version: row.version + 1,
    })
    .where(eq(prescription.id, row.id));
  await audit(tx, {
    action: 'prescription.cancelled',
    outcome: 'allow',
    actor: SYSTEM_ACTOR,
    resourceType: 'prescription',
    resourceId: row.id,
    patientId: row.patientId,
    metadata: { via: 'provider_notice', status: 'issued' },
  });
  return 'cancelled';
}

export interface ReconcileResult {
  settled: number;
  submitted: number;
  failed: number;
}

/**
 * One pass of `erx.reconcile` over an organization (or over one prescription, when a notice from
 * the provider named it): the prescriptions that wait for the provider and are due are tried again,
 * and the issued ones are asked about. A failure of one prescription is logged and does not stop the
 * rest (each one runs in a savepoint).
 *
 * An organization that is read-only submits nothing (issuing is a write); it still settles what the
 * provider reports (a provider notice is allowed there).
 */
export async function reconcileOrganization(
  tx: Tx,
  deps: PrescriptionDeps,
  options: { prescriptionId?: string | undefined } = {},
): Promise<ReconcileResult> {
  const now = deps.clock();
  const result: ReconcileResult = { settled: 0, submitted: 0, failed: 0 };
  const fresh = new Date(now.getTime() - CHECK_EVERY_MS);
  const watched = new Date(now.getTime() - WATCH_DAYS * 86_400_000);

  const rows = await tx
    .select({ id: prescription.id, status: prescription.status })
    .from(prescription)
    .where(
      options.prescriptionId === undefined
        ? or(
            and(
              eq(prescription.status, 'pending_submission'),
              or(isNull(prescription.nextAttemptAt), lte(prescription.nextAttemptAt, now)),
            ),
            and(
              eq(prescription.status, 'issued'),
              gt(prescription.issuedAt, watched),
              or(isNull(prescription.lastCheckedAt), lt(prescription.lastCheckedAt, fresh)),
            ),
          )
        : and(
            eq(prescription.id, options.prescriptionId),
            inArray(prescription.status, ['pending_submission', 'issued']),
          ),
    )
    .orderBy(asc(prescription.createdAt))
    .limit(BATCH);

  for (const row of rows) {
    try {
      await tx.transaction(async (inner) => {
        if (row.status === 'issued') {
          const outcome = await settleFromProvider(inner, deps, row.id);
          if (outcome === 'dispensed' || outcome === 'expired' || outcome === 'cancelled') {
            result.settled += 1;
          }
        } else {
          const outcome: SubmitOutcome = await attemptSubmit(inner, deps, row.id, {
            // A notice that names the prescription is a nudge to try now.
            force: false,
          });
          if (outcome === 'issued') result.submitted += 1;
        }
      });
    } catch (error) {
      result.failed += 1;
      deps.log?.error(
        { prescriptionId: row.id, code: sqlState(error) ?? 'unknown' },
        'a prescription could not be reconciled',
      );
    }
  }
  return result;
}
