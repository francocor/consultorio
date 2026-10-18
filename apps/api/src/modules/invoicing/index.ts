/**
 * Public API of the invoicing module (fiscal configuration, AFIP invoices, credit notes). Other
 * modules and the composition root import from here only.
 *
 * The invoicing track (Track C, S4.08 to S4.13) builds the module here: the fiscal configuration and
 * the certificate (S4.08), then the invoices, the issue job and the screens.
 */
import type { FastifyInstance } from 'fastify';

import type { AdapterResolver } from '../../main/adapter-resolver.js';
import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportInvoicing } from './application/export-contributor.js';
import { configRoutes } from './http/config-routes.js';

export { invoiceLookup } from './application/invoice-lookup.js';
export type { InvoiceLookup } from './application/invoice-lookup.js';
export { invoicingReadiness } from './application/readiness.js';
export type { ReadinessDeps } from './application/readiness.js';
export { isSimulatedIssuer } from './application/issuer.js';
export type { SimulatedInvoiceIssuer } from './application/issuer.js';
export { createCredentialWatchJob, CREDENTIAL_WATCH_JOB } from './jobs/credential-watch.js';

/** Registers what invoicing takes with an organization that leaves (the cancellation export). */
export function registerInvoicingExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'invoicing', exportInvoicing);
}

export interface InvoicingOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** Encrypts the certificate and the key of the organization with its data key. */
  keys: TenantKeys;
  /** Which issuer serves which organization (the simulator, the real one, or none). */
  adapters?: AdapterResolver | undefined;
  clock?: () => Date;
}

export interface Invoicing {
  /** What the module was built with; the track builds its services from it. */
  readonly options: InvoicingOptions;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createInvoicing(options: InvoicingOptions): Invoicing {
  const clock = options.clock ?? (() => new Date());
  const config = configRoutes({
    withTenant: options.withTenant,
    keys: options.keys,
    adapters: options.adapters,
    clock,
  });
  return {
    options,
    routes: (app) => {
      config(app);
    },
  };
}
