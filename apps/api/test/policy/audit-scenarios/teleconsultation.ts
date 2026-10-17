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
  'video.link.opened': { pending: 'S3.14 (task 3.64): the public join address' },
  'video.link.revoked': t('video-links.test.ts'),
  'video.link.joined': { pending: 'S3.14 (task 3.65): the professional joins' },
  'video.link.manual_attached': { pending: 'S3.14 (task 3.65): the manual fallback link' },
};
