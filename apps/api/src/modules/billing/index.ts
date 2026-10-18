/**
 * Public API of the billing module (prices, payers, charges, payments, the cash register and the
 * administrative exports). Other modules and the composition root import from here only.
 *
 * This is the seam skeleton of Stage 4: the module is wired and registered, and does nothing yet.
 * The billing track (Track A, S4.01 to S4.05) adds files under this folder and edits this one.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportBilling } from './application/export-contributor.js';
import { chargeRoutes } from './http/charge-routes.js';
import { pricingRoutes } from './http/pricing-routes.js';

/** Registers what billing takes with an organization that leaves (the cancellation export). */
export function registerBillingExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'billing', exportBilling);
}

export interface BillingOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
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
  const pricing = pricingRoutes({ withTenant: options.withTenant, clock });
  const charges = chargeRoutes({ withTenant: options.withTenant, clock });

  return {
    options,
    routes: (app) => {
      pricing(app);
      charges(app);
    },
  };
}
