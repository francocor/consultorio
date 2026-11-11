import { createConsent, createConsentExpireJob } from '../../modules/consent/index.js';

import type { ModuleWiring } from './types.js';

/** The requests that ran out of time are closed once an hour, for every organization. */
const EXPIRE_EVERY_MS = 60 * 60_000;

/**
 * Everything the consent module registers with the composition root (Track A2). The track edits
 * this file, `modules/consent/` and nothing shared. Consent owns no external provider, so it has no
 * adapter slot. Its audit actions, permissions (`consent.template.manage`, `consent.request`,
 * `clinical.consent.read`), queue and export contributors already exist.
 *
 * The module enqueues no job from a request (the notice of a new request is sent after the commit,
 * by the route), so it does not ask for the queue client; the worker queues `consent.expire` for
 * every organization on its own.
 */
export const consentWiring: ModuleWiring = {
  name: 'consent',
  create: (context) =>
    createConsent({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      keys: context.keys,
      email: context.email,
      origins: context.origins,
      jobs: context.jobs,
      ...(context.clock ? { clock: context.clock } : {}),
    }),
  worker: ({ clock }) => ({
    tenantJobs: [
      {
        definition: createConsentExpireJob({ clock: clock ?? (() => new Date()) }),
        everyMs: EXPIRE_EVERY_MS,
      },
    ],
  }),
};
