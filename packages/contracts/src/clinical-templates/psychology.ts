import { z } from 'zod';

import { freeText } from './common.js';

/**
 * Psychology session (clinical-records, "Psychology template"): date, modality, topics,
 * observations, risk assessment and plan. A medium or high risk needs a follow-up note before the
 * session can be signed; a draft may be saved without it. Psychology is kept out of the shared
 * scope by default (authorization), which is a setting, not a property of the content.
 */
export const PSYCHOLOGY_MODALITIES = ['in_person', 'virtual'] as const;
export type PsychologyModality = (typeof PSYCHOLOGY_MODALITIES)[number];

export const RISK_LEVELS = ['none', 'low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

const fields = {
  topics: freeText(4000).optional(),
  observations: freeText(4000).optional(),
  followUpNote: freeText(2000).optional(),
  plan: freeText(4000).optional(),
};

export const PsychologyDraft = z.strictObject({
  sessionDate: z.iso.date().optional(),
  modality: z.enum(PSYCHOLOGY_MODALITIES).optional(),
  risk: z.enum(RISK_LEVELS).optional(),
  ...fields,
});

export const PsychologyContent = z
  .strictObject({
    sessionDate: z.iso.date(),
    modality: z.enum(PSYCHOLOGY_MODALITIES),
    risk: z.enum(RISK_LEVELS),
    ...fields,
  })
  .superRefine((content, ctx) => {
    if ((content.risk === 'medium' || content.risk === 'high') && !content.followUpNote) {
      ctx.addIssue({
        code: 'custom',
        path: ['followUpNote'],
        message: 'clinical.psychology.follow_up_required',
      });
    }
  });
export type PsychologyContent = z.infer<typeof PsychologyContent>;
