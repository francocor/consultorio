import {
  SAFETY_FLAG_CODES,
  type AnamnesisContent,
  type SafetyFlagCode,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';

import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * The safety flag codes that follow from a structured anamnesis (patients, "Safety alerts without
 * clinical detail"). Pure: the same content always gives the same codes, in the order of the
 * catalog, and free text never raises a flag (only the structured fields do).
 */
export function computeSafetyFlags(content: AnamnesisContent): SafetyFlagCode[] {
  const raised = new Set<SafetyFlagCode>();
  if (content.allergies.length > 0) raised.add('allergy_on_file');
  if (
    content.indicators.anticoagulated ||
    content.medications.some((medication) => medication.anticoagulant === true)
  ) {
    raised.add('anticoagulant_on_file');
  }
  if (content.indicators.pregnant) raised.add('pregnancy');
  if (content.indicators.implantedDevice) raised.add('implanted_device');
  return SAFETY_FLAG_CODES.filter((code) => raised.has(code));
}

/**
 * Writes the codes through the one database function allowed to (migration 0016). The transaction
 * must be acting as a health professional; the function refuses anyone else, and a trigger refuses
 * every other write to `patient.safety_flags`.
 */
export async function applySafetyFlags(
  tx: Tx,
  patientId: string,
  codes: readonly SafetyFlagCode[],
): Promise<void> {
  await tx.execute(
    sql`select app.set_patient_safety_flags(
      current_setting('app.tenant_id')::uuid,
      ${patientId}::uuid,
      array[${sql.join(
        codes.map((code) => sql`${code}`),
        sql`, `,
      )}]::text[])`,
  );
}
