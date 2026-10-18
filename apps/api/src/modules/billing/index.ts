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
import { invoiceLookup, type InvoiceLookup } from '../invoicing/index.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportBilling } from './application/export-contributor.js';
import { flagChargeForReview } from './application/flag-charge.js';
import { cashRoutes } from './http/cash-routes.js';
import { chargeRoutes } from './http/charge-routes.js';
import { paymentRoutes } from './http/payment-routes.js';
import { pricingRoutes } from './http/pricing-routes.js';

/** Registers what billing takes with an organization that leaves (the cancellation export). */
export function registerBillingExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'billing', exportBilling);
}

export interface BillingOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** What scheduling publishes: a no-show or a cancellation flags the charge of the appointment. */
  events?: AppointmentEvents | undefined;
  /** Asks whether an issued invoice stands over a charge (the void rule). Defaults to the stub. */
  invoices?: InvoiceLookup | undefined;
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
  const pricing = pricingRoutes({ withTenant: options.withTenant, clock });
  const charges = chargeRoutes({ withTenant: options.withTenant, clock, invoices });
  const payments = paymentRoutes({ withTenant: options.withTenant, clock });
  const cash = cashRoutes({ withTenant: options.withTenant, clock });

  // Synchronous and in the transaction of the scheduling change (see the event bus).
  options.events?.subscribe((tx, event) => flagChargeForReview(tx, event));

  return {
    options,
    routes: (app) => {
      pricing(app);
      charges(app);
      payments(app);
      cash(app);
    },
  };
}
