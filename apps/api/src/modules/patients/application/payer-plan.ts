import { and, asc, desc, eq, gte, isNull, lte, or } from 'drizzle-orm';

import { patientCoverage, payerPlan } from '../../../db/schema/coverage.js';
import { payer } from '../../../db/schema/platform-catalogs.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/** The payer and plan a patient is covered by, as billing needs them to price a charge. */
export interface PatientPayerPlan {
  /** The payer plan of the organization the coverage points at. */
  payerPlanId: string;
  /** The payer of the platform catalog, or null for one the organization named itself. */
  payerId: string | null;
  customName: string | null;
  planName: string | null;
  payerName: string;
  /** `private` is "Particular", a patient who pays for themselves; null for a custom payer. */
  payerKind: 'obra_social' | 'prepaga' | 'private' | null;
}

/**
 * The coverage that applies to a patient on a day: the live coverage whose validity includes the
 * day, the primary one first. `null` for a patient with none (a private patient). Billing reads
 * it through here, not through the tables of coverage.
 */
export async function readPatientPayerPlan(
  tx: Tx,
  patientId: string,
  onDate: string,
): Promise<PatientPayerPlan | null> {
  const [row] = await tx
    .select({
      payerPlanId: payerPlan.id,
      payerId: payerPlan.payerId,
      customName: payerPlan.customName,
      planName: payerPlan.planName,
      catalogName: payer.name,
      catalogKind: payer.kind,
    })
    .from(patientCoverage)
    .innerJoin(payerPlan, eq(payerPlan.id, patientCoverage.payerPlanId))
    .leftJoin(payer, eq(payer.id, payerPlan.payerId))
    .where(
      and(
        eq(patientCoverage.patientId, patientId),
        isNull(patientCoverage.endedAt),
        or(isNull(patientCoverage.validFrom), lte(patientCoverage.validFrom, onDate)),
        or(isNull(patientCoverage.validTo), gte(patientCoverage.validTo, onDate)),
      ),
    )
    .orderBy(
      desc(patientCoverage.isPrimary),
      asc(patientCoverage.createdAt),
      asc(patientCoverage.id),
    )
    .limit(1);
  if (!row) return null;
  return {
    payerPlanId: row.payerPlanId,
    payerId: row.payerId,
    customName: row.customName,
    planName: row.planName,
    payerName: row.catalogName ?? row.customName ?? '',
    payerKind:
      row.catalogKind === 'obra_social' ||
      row.catalogKind === 'prepaga' ||
      row.catalogKind === 'private'
        ? row.catalogKind
        : null,
  };
}
