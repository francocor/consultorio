import { z } from 'zod';

import { freeText, shortText } from './common.js';

/**
 * Physiotherapy session (clinical-records, "Physiotherapy template"): pain on a 0 to 10 scale,
 * affected region, range of motion per joint, functional tests, procedures applied, the session
 * number within the treatment plan and the plan goals.
 */
export const ROM_UNITS = ['deg', 'cm'] as const;
export type RomUnit = (typeof ROM_UNITS)[number];

const RangeOfMotion = z.strictObject({
  joint: shortText(80),
  value: z.number().min(0).max(360),
  unit: z.enum(ROM_UNITS),
});

const SessionCount = z.number().int().min(1).max(500);

/** Pain is a whole number from 0 (none) to 10 (worst imaginable). */
const Pain = z.number().int().min(0).max(10);

const fields = {
  rangeOfMotion: z.array(RangeOfMotion).max(30).optional(),
  functionalTests: freeText(2000).optional(),
  procedures: freeText(2000).optional(),
  totalSessions: SessionCount.optional(),
  goals: freeText(2000).optional(),
};

export const PhysiotherapyDraft = z.strictObject({
  painIntensity: Pain.optional(),
  affectedRegion: freeText(120).optional(),
  sessionNumber: SessionCount.optional(),
  ...fields,
});

export const PhysiotherapyContent = z
  .strictObject({
    painIntensity: Pain,
    affectedRegion: shortText(120),
    sessionNumber: SessionCount,
    ...fields,
  })
  .superRefine((content, ctx) => {
    if (content.totalSessions !== undefined && content.sessionNumber > content.totalSessions) {
      ctx.addIssue({
        code: 'custom',
        path: ['sessionNumber'],
        message: 'clinical.physiotherapy.session_exceeds_plan',
      });
    }
  });
export type PhysiotherapyContent = z.infer<typeof PhysiotherapyContent>;
