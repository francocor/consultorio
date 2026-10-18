/**
 * Public API of the billing module (prices, payers, charges, payments, the cash register and the
 * administrative exports). Other modules and the composition root import from here only.
 *
 * Track A (S4.01 to S4.05) fills it in. What other modules may call is exported below; the invoicing
 * track reads the charge lines through `readChargeLines` and friends.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { AppointmentEvents } from '../../platform/events/appointment-events.js';
import { createExportJob } from '../../platform/exports/export-job.js';
import type { FileResourceRegistry } from '../../platform/files/file-resources.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import type { ObjectStorage } from '../../platform/storage/object-storage.js';
import { createActionTokens } from '../../platform/tokens/index.js';
import { invoiceLookup, type InvoiceLookup } from '../invoicing/index.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportBilling } from './application/export-contributor.js';
import { BILLING_EXPORT_SOURCES } from './application/export-sources.js';
import {
  createExportFileResource,
  exportStore,
  organizationBranding,
} from './application/exports.js';
import { flagChargeForReview } from './application/flag-charge.js';
import { cashRoutes } from './http/cash-routes.js';
import { chargeRoutes } from './http/charge-routes.js';
import { exportRoutes } from './http/export-routes.js';
import { paymentRoutes } from './http/payment-routes.js';
import { pricingRoutes } from './http/pricing-routes.js';

// The charge lines, for the invoicing module (track C). Invoices are built over these and nothing
// else of billing: read the lines (locked while an invoice is built), with their charge and payer,
// and the facts of their charges. `invoiced_cents` is written by the trigger of the invoices, never
// by billing. The contract is documented in docs/stage4-charge-lines.md.
export {
  readChargeLines,
  readChargeLinesOfCharges,
  readChargesForInvoicing,
} from './application/charge-lines.js';
export type {
  ChargeForInvoicing,
  ChargeLineForInvoicing,
  ChargePayer,
} from './application/charge-lines.js';

/** Registers what billing takes with an organization that leaves (the cancellation export). */
export function registerBillingExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'billing', exportBilling);
}

/**
 * The `export.build` job of billing: builds the file of an export request (charges, payments, payer
 * settlement) and stores it. The worker registers it; the tests run it by hand.
 */
export function createBillingExportJob(deps: { storage: ObjectStorage; clock?: () => Date }) {
  return createExportJob({
    sources: BILLING_EXPORT_SOURCES,
    store: exportStore,
    storage: deps.storage,
    branding: organizationBranding,
    clock: deps.clock ?? (() => new Date()),
  });
}

export interface BillingOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** What scheduling publishes: a no-show or a cancellation flags the charge of the appointment. */
  events?: AppointmentEvents | undefined;
  /** Asks whether an issued invoice stands over a charge (the void rule). Defaults to the stub. */
  invoices?: InvoiceLookup | undefined;
  /** Queues the export job. Absent in a deployment without a queue: exports answer "unavailable". */
  jobs?: JobClient | undefined;
  /** Where `GET /files/:token` finds the resource of the export links. */
  fileResources?: FileResourceRegistry | undefined;
  clock?: () => Date;
}

export interface Billing {
  /** What the module was built with; the track builds its services from it. */
  readonly options: BillingOptions;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createBilling(options: BillingOptions): Billing {
  const clock = options.clock ?? (() => new Date());
  const invoices = options.invoices ?? invoiceLookup;
  const tokens = createActionTokens({ clock });
  const pricing = pricingRoutes({ withTenant: options.withTenant, clock });
  const charges = chargeRoutes({ withTenant: options.withTenant, clock, invoices });
  const payments = paymentRoutes({ withTenant: options.withTenant, clock });
  const cash = cashRoutes({ withTenant: options.withTenant, clock });
  const exportApi = exportRoutes({ withTenant: options.withTenant, jobs: options.jobs, tokens });

  // Synchronous and in the transaction of the scheduling change (see the event bus).
  options.events?.subscribe((tx, event) => flagChargeForReview(tx, event));
  // The files of the exports open through the one door of the platform, with their own rules.
  options.fileResources?.register(createExportFileResource(tokens));

  return {
    options,
    routes: (app) => {
      pricing(app);
      charges(app);
      payments(app);
      cash(app);
      exportApi(app);
    },
  };
}
