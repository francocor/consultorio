/**
 * Public API of the portal module (the patient portal: identities, links, sign-in by emailed code,
 * read models and downloads). Other modules and the composition root import from here only.
 *
 * This is the seam skeleton of Stage 5: the module is wired and registered, and does nothing yet.
 * The portal track (Track B, S5.06 to S5.10) adds files under this folder and edits this one. The
 * module owns no clinical table: it reads consents, prescriptions, invoices and documents only
 * through the `index.ts` of the module that owns them, as the `PortalActor` of the session.
 */
import type { FastifyInstance } from 'fastify';

import type { AdapterResolver } from '../../main/adapter-resolver.js';
import type { PortalActor } from '../../platform/authz/actor.js';
import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { FileResourceRegistry } from '../../platform/files/file-resources.js';
import type { PublicOrigins } from '../../platform/http/public-origin.js';
import type { RateLimitStore } from '../../platform/http/rate-limit.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import type { EmailSender } from '../../platform/mail/email-sender.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportPortal } from './application/export-contributor.js';

/** Registers what the portal takes with an organization that leaves: identities and links. */
export function registerPortalExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'portal', exportPortal);
}

export interface PortalOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  keys: TenantKeys;
  /** Sends the activation links and the sign-in codes (through the channel policy: email only). */
  email: EmailSender;
  /** Where emailed links point (never the Host header of a request). */
  origins: PublicOrigins;
  /** The counters of the sign-in throttles. */
  rateLimitStore: RateLimitStore;
  /** Queues the codes and the majority review. Absent when no module needs the queue. */
  jobs?: JobClient | undefined;
  adapters?: AdapterResolver | undefined;
  /**
   * What the portal's own door to files serves (patient downloads). It is not the staff registry:
   * its resources take the `PortalActor` of the session and authorize the subject again.
   */
  portalFileResources: FileResourceRegistry<PortalActor>;
  clock?: () => Date;
}

export interface Portal {
  /** What the module was built with; the track builds its services from it. */
  readonly options: PortalOptions;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createPortal(options: PortalOptions): Portal {
  return { options, routes: () => undefined };
}
