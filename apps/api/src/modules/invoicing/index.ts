/**
 * Public API of the invoicing module (fiscal configuration, AFIP invoices, credit notes). Other
 * modules and the composition root import from here only.
 *
 * This is the seam skeleton of Stage 4: the module is wired and registered, and does nothing yet.
 * The invoicing track (Track C, S4.08 to S4.13) adds files under this folder and edits this one.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportInvoicing } from './application/export-contributor.js';

export { invoiceLookup } from './application/invoice-lookup.js';
export type { InvoiceLookup } from './application/invoice-lookup.js';

/** Registers what invoicing takes with an organization that leaves (the cancellation export). */
export function registerInvoicingExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'invoicing', exportInvoicing);
}

export interface InvoicingOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  clock?: () => Date;
}

export interface Invoicing {
  /** What the module was built with; the track builds its services from it. */
  readonly options: InvoicingOptions;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createInvoicing(options: InvoicingOptions): Invoicing {
  return { options, routes: () => undefined };
}
