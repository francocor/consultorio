import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../../platform/authz/guard.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import type { FileResourceRegistry } from '../../../platform/files/file-resources.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import { createActionTokens } from '../../../platform/tokens/index.js';
import type { ExportRegistry } from '../application/export-registry.js';
import type { TenantLifecycle } from '../application/lifecycle.js';

import { createCancellationDelivery, createCancellationFileResource } from './delivery.js';
import { exportRoutes } from './http/export-routes.js';
import { subscribeCancellationExport } from './queue.js';

/**
 * The cancellation export of Stage 6 (tenancy, "Tenant cancellation export"): an administrative
 * package for the owner and one clinical package per professional, built by the job `export.build`
 * from the contributors every module registered in the export registry.
 *
 * The module subscribes to the end of an organization (the request of the export is written inside
 * the transaction that cancelled: see `queue.ts`), registers the `cancellation_export` resource with
 * the door of the files and serves the state and the download link of the two kinds of package. The
 * job itself runs in the worker (`build-export.ts`, wired in `main/wiring/tenancy.ts`).
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
  /** Where `GET /files/:token` finds the resource of the package links. */
  fileResources?: FileResourceRegistry | undefined;
  clock?: () => Date;
}

export interface Cancellation {
  /** What the module was built with; the track builds its services from it. */
  readonly options: CancellationOptions;
  /** The HTTP routes of the module: where the packages stand and the links to download them. */
  routes: (app: FastifyInstance) => void;
}

export function createCancellation(options: CancellationOptions): Cancellation {
  const tokens = createActionTokens(options.clock ? { clock: options.clock } : {});
  const delivery = createCancellationDelivery({ tokens });

  // The end of an organization asks for its export; the packages open through the door of the files.
  subscribeCancellationExport(options.lifecycle);
  options.fileResources?.register(createCancellationFileResource(tokens));

  return {
    options,
    routes: exportRoutes({ withTenant: options.withTenant, delivery }),
  };
}
