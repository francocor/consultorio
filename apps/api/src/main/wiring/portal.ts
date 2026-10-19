import { createConsentPortal } from '../../modules/consent/index.js';
import {
  adaptConsentModule,
  adaptPrescriptionModule,
  createMajorityReviewJob,
  createPortal,
  createPortalCodeSendJob,
  type PortalConsentPort,
  type PortalPrescriptionPort,
} from '../../modules/portal/index.js';
import {
  listPrescriptionsForPatient,
  openPortalDocument,
  type PrescriptionDeps,
} from '../../modules/prescriptions/index.js';
import { createTenantRoutedEmail } from '../adapter-resolver.js';

import type { ModuleWiring, WiringContext } from './types.js';

/** The review of the dependents who reached the age of majority runs once a day. */
const MAJORITY_REVIEW_EVERY_MS = 24 * 3_600_000;

/**
 * What the portal needs from the modules that are built in parallel: a port per module, from
 * `modules/portal/application/ports.ts`. Left out, the section of the portal answers
 * `available: false` and the screen shows its empty state.
 */
export interface PortalPorts {
  consent?: PortalConsentPort | undefined;
  prescriptions?: PortalPrescriptionPort | undefined;
}

/** The doors of the real modules, built from what the composition root holds. */
export function realPortalPorts(context: WiringContext): PortalPorts {
  const { keys, withTenant } = context;
  // The same dependencies the prescriptions module is built with (`wiring/prescriptions.ts`): the
  // portal opens a document through the module's own function, which may have to render it first.
  const prescriptionDeps: PrescriptionDeps = {
    keys,
    adapters: context.adapters,
    clock: context.clock ?? (() => new Date()),
    jobs: context.jobs,
    withTenant,
    storage: context.storage,
  };
  return {
    consent: adaptConsentModule(
      createConsentPortal({ keys, ...(context.clock ? { clock: context.clock } : {}) }),
    ),
    prescriptions: adaptPrescriptionModule({
      // Both run on the transaction of the portal request and open no other connection. A document
      // that was not stored yet is rendered in memory, so no bucket is needed to offer it.
      list: (tx, input) => listPrescriptionsForPatient(tx, input, { canRender: true }),
      openDocument: (tx, input) => openPortalDocument(tx, prescriptionDeps, input),
    }),
  };
}

/** The doors as given, or built from the context when the application is composed. */
export type PortalPortsSource = PortalPorts | ((context: WiringContext) => PortalPorts);

/**
 * Everything the portal module registers with the composition root (Track B). The track edits this
 * file, `modules/portal/` and nothing shared: it sets `needsJobs` for the codes, adds the code job to
 * the worker, registers the resources of the portal's own door to files in `portalFileResources`
 * (never in the staff registry) and mounts its routes. The portal owns no external provider, so it
 * has no adapter slot: the code is an email, sent through the channel policy (kind `portal_notice`).
 * Its permissions, audit actions, queues and the `PortalActor` already exist.
 */
export function createPortalWiring(source: PortalPortsSource = {}): ModuleWiring {
  return {
    name: 'portal',
    // The sign-in code goes out by a job (queue `portal.code_send`, category `auth`), so the API
    // process holds a queue client.
    needsJobs: true,
    worker: (context) => {
      const clock = context.clock ? { clock: context.clock } : {};
      // The tenant-routed sender: a demo organization's codes never reach the real provider.
      const email = createTenantRoutedEmail(context.adapters);
      return {
        jobs: () => [createPortalCodeSendJob({ email, ...clock })],
        // Once a day, for every organization: the dependents who turned 18 stop being represented.
        tenantJobs: [
          { definition: createMajorityReviewJob(clock), everyMs: MAJORITY_REVIEW_EVERY_MS },
        ],
      };
    },
    create: (context) => {
      const ports = typeof source === 'function' ? source(context) : source;
      return createPortal({
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
        storage: context.storage,
        consent: ports.consent,
        prescriptions: ports.prescriptions,
        ...(context.clock ? { clock: context.clock } : {}),
      });
    },
  };
}

export const portalWiring: ModuleWiring = createPortalWiring(realPortalPorts);
