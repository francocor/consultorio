import { z } from 'zod';

import { REQUIRED, freeText } from './common.js';

/**
 * Odontology encounter with an odontogram (clinical-records, "Odontogram template"). Teeth use
 * FDI notation (two digits: quadrant, then position) for the permanent dentition (11 to 48) and
 * the primary one (51 to 85). Each tooth carries a condition and, per surface, a finding and a
 * treatment. The date and the author of an entry are those of the signed note; the CURRENT chart
 * is derived from the series of signed entries (`deriveCurrentOdontogram`) and never overwrites an
 * earlier one.
 */
const permanent = [1, 2, 3, 4].flatMap((quadrant) =>
  [1, 2, 3, 4, 5, 6, 7, 8].map((position) => `${String(quadrant)}${String(position)}`),
);
const primary = [5, 6, 7, 8].flatMap((quadrant) =>
  [1, 2, 3, 4, 5].map((position) => `${String(quadrant)}${String(position)}`),
);

export const FDI_PERMANENT: readonly string[] = permanent;
export const FDI_PRIMARY: readonly string[] = primary;
export const FDI_CODES: readonly string[] = [...permanent, ...primary];

const CODES = new Set(FDI_CODES);

/** True for a tooth code of the FDI notation, permanent or primary. */
export function isToothCode(value: string): boolean {
  return CODES.has(value);
}

export const TOOTH_CONDITIONS = [
  'healthy',
  'caries',
  'restoration',
  'crown',
  'extraction',
  'implant',
  'missing',
  'endodontic',
] as const;
export type ToothCondition = (typeof TOOTH_CONDITIONS)[number];

export const TOOTH_SURFACES = ['mesial', 'distal', 'occlusal', 'vestibular', 'lingual'] as const;
export type ToothSurface = (typeof TOOTH_SURFACES)[number];

export const SURFACE_FINDINGS = ['healthy', 'caries', 'restoration', 'fracture', 'wear'] as const;
export type SurfaceFinding = (typeof SURFACE_FINDINGS)[number];

const SurfaceRecord = z.strictObject({
  finding: z.enum(SURFACE_FINDINGS).optional(),
  treatment: freeText(200).optional(),
});

const ToothRecord = z.strictObject({
  condition: z.enum(TOOTH_CONDITIONS).optional(),
  surfaces: z.partialRecord(z.enum(TOOTH_SURFACES), SurfaceRecord).optional(),
  note: freeText(500).optional(),
});
export type ToothRecord = z.infer<typeof ToothRecord>;

const ToothCode = z.string().refine(isToothCode, 'clinical.odontology.invalid_tooth');

/** Tooth code (FDI) to what was recorded on it in this entry. */
export const Odontogram = z.record(ToothCode, ToothRecord);
export type Odontogram = z.infer<typeof Odontogram>;

const fields = {
  odontogram: Odontogram.optional(),
  notes: freeText(4000).optional(),
  treatmentPlan: freeText(4000).optional(),
};

export const OdontologyDraft = z.strictObject({
  reasonForConsultation: freeText(2000).optional(),
  ...fields,
});

export const OdontologyContent = z.strictObject({
  reasonForConsultation: z.string().trim().min(1, REQUIRED).max(2000),
  ...fields,
});
export type OdontologyContent = z.infer<typeof OdontologyContent>;

/** One signed odontology entry, as the chart derivation needs it. */
export interface OdontogramEntry {
  /** When the entry was signed (ISO 8601). */
  signedAt: string;
  authorProfessionalId: string;
  odontogram: Odontogram;
}

export interface CurrentTooth {
  condition?: ToothCondition | undefined;
  surfaces: Partial<Record<ToothSurface, z.infer<typeof SurfaceRecord>>>;
  note?: string | undefined;
  /** The signature date of the entry that last said something about this tooth. */
  updatedAt: string;
  authorProfessionalId: string;
}
export type CurrentOdontogram = Record<string, CurrentTooth>;

/**
 * The current state of the chart: for each tooth, the latest signed entry that recorded its
 * condition, surface or note wins; what a later entry does not mention stays as it was. The
 * entries are never modified, so each earlier signed state is still what it was.
 */
export function deriveCurrentOdontogram(entries: readonly OdontogramEntry[]): CurrentOdontogram {
  const ordered = [...entries].sort((a, b) => a.signedAt.localeCompare(b.signedAt));
  const current: CurrentOdontogram = {};
  for (const entry of ordered) {
    for (const [code, record] of Object.entries(entry.odontogram)) {
      const before = current[code];
      const surfaces = { ...before?.surfaces, ...record.surfaces };
      current[code] = {
        condition: record.condition ?? before?.condition,
        surfaces,
        note: record.note ?? before?.note,
        updatedAt: entry.signedAt,
        authorProfessionalId: entry.authorProfessionalId,
      };
    }
  }
  return current;
}
