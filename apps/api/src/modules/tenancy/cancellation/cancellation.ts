import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../../platform/authz/guard.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import type { ExportRegistry } from '../application/export-registry.js';
import type { TenantLifecycle } from '../application/lifecycle.js';

/**
 * The cancellation export of Stage 6 (tenancy, "Tenant cancellation export"): an administrative
 * package for the owner and one clinical package per professional, built by the job `export.build`
 * from the contributors every module registered in the export registry.
 *
 * Seam skeleton: the module is registered through the tenancy `index.ts` and does nothing yet. The
 * retention track (Track C, S6.08) adds files under this folder, subscribes to
 * `tenantLifecycle.onCancelled` in its own wiring and edits this one.
 */

export interface CancellationOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** Decrypts the clinical parts for the professional they are made for. */
  keys: TenantKeys;
  /** Every module's contributor: the export is made of them. */
  exports: ExportRegistry;
  /** Where an organization's end is announced; this module subscribes to it. */
  lifecycle: TenantLifecycle;
  /** Queues `export.build`. Absent when no module needs the queue. */
  jobs?: JobClient | undefined;
  clock?: () => Date;
}

export interface Cancellation {
  /** What the module was built with; the track builds its services from it. */
  readonly options: CancellationOptions;
  /** The HTTP routes of the module: the downloads of the packages (category `export`). */
  routes: (app: FastifyInstance) => void;
}

export function createCancellation(options: CancellationOptions): Cancellation {
  return { options, routes: () => undefined };
}
