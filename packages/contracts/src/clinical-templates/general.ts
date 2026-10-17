import { z } from 'zod';

import { REQUIRED, freeText, shortText } from './common.js';

/**
 * General encounter (clinical-records, "Encounter notes"): reason for consultation, symptoms or
 * findings, measurements (free-form name, value and unit), diagnosis, treatment or plan and
 * medications. Only the reason is required to sign.
 */
const Measurement = z.strictObject({
  name: shortText(80),
  value: shortText(40),
  unit: freeText(20).optional(),
});

const Medication = z.strictObject({
  name: shortText(120),
  dose: freeText(80).optional(),
  frequency: freeText(80).optional(),
});

const fields = {
  symptoms: freeText(4000).optional(),
  measurements: z.array(Measurement).max(30).optional(),
  diagnosis: freeText(2000).optional(),
  plan: freeText(4000).optional(),
  medications: z.array(Medication).max(40).optional(),
};

export const GeneralDraft = z.strictObject({
  reasonForConsultation: freeText(2000).optional(),
  ...fields,
});

export const GeneralContent = z.strictObject({
  reasonForConsultation: z.string().trim().min(1, REQUIRED).max(2000),
  ...fields,
});
export type GeneralContent = z.infer<typeof GeneralContent>;
