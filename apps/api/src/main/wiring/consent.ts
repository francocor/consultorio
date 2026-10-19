import { createConsent } from '../../modules/consent/index.js';

import type { ModuleWiring } from './types.js';

/**
 * Everything the consent module registers with the composition root (Track A2). The track edits
 * this file, `modules/consent/` and nothing shared: it sets `needsJobs` for `consent.expire`, adds
 * that job to the worker and reads the settings it needs. Consent owns no external provider, so it
 * has no adapter slot. Its audit actions, permissions (`consent.template.manage`,
 * `consent.request`, `clinical.consent.read`), queue and export contributors already exist.
 */
export const consentWiring: ModuleWiring = {
  name: 'consent',
  create: (context) =>
    createConsent({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      keys: context.keys,
      jobs: context.jobs,
      ...(context.clock ? { clock: context.clock } : {}),
    }),
};
