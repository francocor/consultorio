import {
  createPortal,
  createPortalCodeSendJob,
  type PortalConsentPort,
  type PortalPrescriptionPort,
} from '../../modules/portal/index.js';
import { createTenantRoutedEmail } from '../adapter-resolver.js';

import type { ModuleWiring } from './types.js';

/**
 * What the portal needs from the modules that are built in parallel and merged later. Each one is a
 * port of `modules/portal/application/ports.ts`, implemented on top of the `index.ts` of the module
 * that owns the data. Left out, the section of the portal answers `available: false` and the screen
 * shows its empty state.
 *
 * INTEGRATOR (merging tracks A2 and A3): build the two ports from the exports those modules
 * document (see the report of Track B and `docs/stage5-tracks.md`) and pass them in `portalWiring`
 * below, for example `createPortalWiring({ consent: createPortalConsentPort(...), prescriptions:
 * createPortalPrescriptionPort(...) })`. Nothing else of the portal changes.
 */
export interface PortalPorts {
  consent?: PortalConsentPort | undefined;
  prescriptions?: PortalPrescriptionPort | undefined;
}

/**
 * Everything the portal module registers with the composition root (Track B). The track edits this
 * file, `modules/portal/` and nothing shared: it sets `needsJobs` for the codes, adds the code job to
 * the worker, registers the resources of the portal's own door to files in `portalFileResources`
 * (never in the staff registry) and mounts its routes. The portal owns no external provider, so it
 * has no adapter slot: the code is an email, sent through the channel policy (kind `portal_notice`).
 * Its permissions, audit actions, queues and the `PortalActor` already exist.
 */
export function createPortalWiring(ports: PortalPorts = {}): ModuleWiring {
  return {
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
        appointmentEvents: context.appointmentEvents,
        videoJoin: context.videoJoin.resolver,
        consent: ports.consent,
        prescriptions: ports.prescriptions,
        ...(context.clock ? { clock: context.clock } : {}),
      }),
  };
}

export const portalWiring: ModuleWiring = createPortalWiring();
