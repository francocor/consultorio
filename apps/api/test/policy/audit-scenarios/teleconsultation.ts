import type { TELECONSULTATION_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

const t = (file: string): AuditScenario => ({ test: `apps/api/test/integration/${file}` });

/**
 * Where the audit actions of video links are proven. Track D (teleconsultation) replaces each
 * `pending` with the integration test that names the action, in this file only.
 */
export const TELECONSULTATION_SCENARIOS: Record<
  (typeof TELECONSULTATION_AUDIT_ACTIONS)[number],
  AuditScenario
> = {
  'video.link.created': t('video-links.test.ts'),
  'video.link.opened': t('video-join-public.test.ts'),
  'video.link.revoked': t('video-links.test.ts'),
  'video.link.joined': t('video-professional.test.ts'),
  'video.link.manual_attached': t('video-professional.test.ts'),
};
