/**
 * Public API of the waitlist module (waiting entries and the offers of freed slots).
 * Other modules and the composition root import from here only.
 *
 * Track C (S3.11 to S3.13) fills this module in: the entries reception manages, the matching of
 * freed slots, the offers with their expiry and the public self-join.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import { createSchedulingPorts } from '../scheduling/index.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportWaitlist } from './application/export-contributor.js';
import { entryRoutes } from './http/entry-routes.js';

export { closeEntriesOfOptedOutPatient, closeExpiredEntries } from './application/entries.js';

/** Registers what waitlist takes with an organization that leaves (the cancellation export). */
export function registerWaitlistExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'waitlist', exportWaitlist);
}

export interface WaitlistOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** The key service, for the scheduling ports (they encrypt the detail of worklist items). */
  keys: TenantKeys;
  clock?: () => Date;
}

export interface Waitlist {
  /** What the module was built with; the track builds its services from it. */
  readonly options: WaitlistOptions;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createWaitlist(options: WaitlistOptions): Waitlist {
  const clock = options.clock ?? (() => new Date());
  const entries = entryRoutes({
    withTenant: options.withTenant,
    entries: { portsOf: (tx) => createSchedulingPorts(tx, { keys: options.keys }) },
    clock,
  });

  return {
    options,
    routes: (app) => {
      entries(app);
    },
  };
}
