import { z } from 'zod';

/**
 * Anamnesis: medical history, allergies, medications and antecedents of a patient. It is CLINICAL
 * data: only health professionals read or write it, every access is audited, and it is stored
 * encrypted. These are the only schemas in the contracts that carry clinical content; the registry
 * schemas (`PatientDto`, `PatientSummaryDto`, ...) never do.
 */

/**
 * The codes of the safety flag (patients, "Safety alerts without clinical detail"): a derived,
 * minimal indicator that reception sees as "see professional". The system computes it from the
 * structured anamnesis on every save. No request schema anywhere has a field for it.
 */
export const SAFETY_FLAG_CODES = [
  'allergy_on_file',
  'anticoagulant_on_file',
  'pregnancy',
  'implanted_device',
] as const;
export type SafetyFlagCode = (typeof SAFETY_FLAG_CODES)[number];

const ShortText = z.string().trim().min(1).max(120);

export const AllergyEntry = z.strictObject({
  substance: ShortText,
  reaction: z.string().trim().max(200).optional(),
  severity: z.enum(['mild', 'moderate', 'severe']).optional(),
});

export const MedicationEntry = z.strictObject({
  name: ShortText,
  dose: z.string().trim().max(80).optional(),
  /** Marks a medication that thins the blood: it raises the `anticoagulant_on_file` flag. */
  anticoagulant: z.boolean().optional(),
});

export const ConditionEntry = z.strictObject({
  name: ShortText,
  since: z.string().trim().max(40).optional(),
});

export const AnamnesisContent = z.strictObject({
  allergies: z.array(AllergyEntry).max(50),
  medications: z.array(MedicationEntry).max(50),
  conditions: z.array(ConditionEntry).max(50),
  /** Antecedents in the professional's own words. */
  antecedents: z.string().trim().max(4000),
  /** Situations that need safe handling by whoever attends the patient. */
  indicators: z.strictObject({
    pregnant: z.boolean(),
    implantedDevice: z.boolean(),
    anticoagulated: z.boolean(),
  }),
});
export type AnamnesisContent = z.infer<typeof AnamnesisContent>;

export const EMPTY_ANAMNESIS: AnamnesisContent = {
  allergies: [],
  medications: [],
  conditions: [],
  antecedents: '',
  indicators: { pregnant: false, implantedDevice: false, anticoagulated: false },
};

/** Saves a new version. `expectedVersion` is the one the professional started from (0 for none). */
export const SaveAnamnesisRequest = z.strictObject({
  content: AnamnesisContent,
  expectedVersion: z.number().int().min(0).optional(),
});
export type SaveAnamnesisRequest = z.infer<typeof SaveAnamnesisRequest>;

export const AnamnesisVersionDto = z.strictObject({
  version: z.number().int().min(1),
  savedAt: z.iso.datetime(),
  authorProfessionalId: z.uuid(),
  content: AnamnesisContent,
});
export type AnamnesisVersionDto = z.infer<typeof AnamnesisVersionDto>;

export const AnamnesisResponse = z.strictObject({
  /** The latest version, or null when none was recorded yet. */
  current: AnamnesisVersionDto.nullable(),
});
export type AnamnesisResponse = z.infer<typeof AnamnesisResponse>;

/**
 * The only thing reception, an owner or an admin gets to know about the anamnesis: that the
 * system holds a safety flag. The detail never leaves the professionals.
 */
export const SAFETY_FLAG_LABEL_KEY = 'patients.safety_flag.see_professional';
