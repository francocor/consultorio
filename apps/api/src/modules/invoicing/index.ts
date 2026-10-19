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
import type { FileResourceRegistry } from '../../platform/files/file-resources.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import { createActionTokens } from '../../platform/tokens/index.js';
import type { ExportRegistry } from '../tenancy/index.js';

import type { InvoiceWorklist } from './application/common.js';
import { exportInvoicing } from './application/export-contributor.js';
import { createInvoiceFileResource } from './application/invoice-document.js';
import { configRoutes } from './http/config-routes.js';
import { invoiceRoutes } from './http/invoice-routes.js';

export { invoiceLookup } from './application/invoice-lookup.js';
export type { InvoiceLookup } from './application/invoice-lookup.js';
export { invoicingReadiness } from './application/readiness.js';
export type { ReadinessDeps } from './application/readiness.js';
export { isSimulatedIssuer } from './application/issuer.js';
export type { SimulatedInvoiceIssuer } from './application/issuer.js';
export { createCredentialWatchJob, CREDENTIAL_WATCH_JOB } from './jobs/credential-watch.js';
export { createAfipIssueJob, AFIP_ISSUE_JOB } from './jobs/afip-issue.js';
export { createInvoicePdfJob, INVOICE_PDF_JOB } from './jobs/invoice-pdf.js';
export { createInvoiceDeliverJob, INVOICE_DELIVER_JOB } from './jobs/invoice-deliver.js';
// The patient portal (Stage 5): the invoices addressed to one patient.
export { listInvoicesForPatient } from './application/patient-invoices.js';
// Reports (S4.14): the lines of the issued and registered vouchers of a period, and how to add them up.
export { readInvoicedLines } from './application/invoiced-lines.js';
export type { InvoicedLinesFilter } from './application/invoiced-lines.js';
export { PRIVATE_PAYER_KEY, summarizeInvoiced } from './domain/invoiced-summary.js';
export type { InvoicedGroup, InvoicedGroupBy, InvoicedLine } from './domain/invoiced-summary.js';
export { runDueAttempts } from './application/due-invoices.js';
export { highestNumberRecorded } from './application/numbers-held.js';
export type { DueLog } from './application/due-invoices.js';
export type { IssueDeps, AttemptOutcome } from './application/issue-attempt.js';

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
  /** Queues the submission of an invoice. Without a queue the worker's sweeper takes them up. */
  jobs?: JobClient | undefined;
  /** Where `GET /files/:token` finds the resource of the invoice PDF links. */
  fileResources?: FileResourceRegistry | undefined;
  /** The reception worklist: a manual voucher takes the invoice it replaces off it. */
  worklist?: InvoiceWorklist | undefined;
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
  const tokens = createActionTokens({ clock });
  const invoices = invoiceRoutes({
    withTenant: options.withTenant,
    adapters: options.adapters,
    jobs: options.jobs,
    worklist: options.worklist,
    clock,
    tokens,
  });
  // The PDFs of the invoices open through the one door of the platform, with their own rules.
  options.fileResources?.register(createInvoiceFileResource(tokens));
  return {
    options,
    routes: (app) => {
      config(app);
      invoices(app);
    },
  };
}
