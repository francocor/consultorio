import { createPortal, createPortalCodeSendJob } from '../../modules/portal/index.js';
import { createTenantRoutedEmail } from '../adapter-resolver.js';

import type { ModuleWiring } from './types.js';

/**
 * Everything the portal module registers with the composition root (Track B). The track edits this
 * file, `modules/portal/` and nothing shared: it sets `needsJobs` for the codes and the majority
 * review, adds `portal.majority_review` to the worker, registers the resources of the portal's own
 * door to files in `portalFileResources` (never in the staff registry) and mounts its routes. The
 * portal owns no external provider, so it has no adapter slot: the code is an email, sent through
 * the channel policy (kind `portal_notice`). Its permissions, audit actions, queue and the
 * `PortalActor` already exist.
 */
export const portalWiring: ModuleWiring = {
  name: 'portal',
  // The sign-in code goes out by a job (queue `portal.code_send`, category `auth`), so the API
  // process holds a queue client.
  needsJobs: true,
  worker: (context) => {
    // The tenant-routed sender: a demo organization's codes never reach the real provider.
    const email = createTenantRoutedEmail(context.adapters);
    return {
      jobs: () => [
        createPortalCodeSendJob({ email, ...(context.clock ? { clock: context.clock } : {}) }),
      ],
    };
  },
  create: (context) =>
    createPortal({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      keys: context.keys,
      email: context.email,
      origins: context.origins,
      rateLimitStore: context.rateLimitStore,
      jobs: context.jobs,
      adapters: context.adapters,
      portalFileResources: context.portalFileResources,
      ...(context.clock ? { clock: context.clock } : {}),
    }),
};
