/**
 * Public API of the subscriptions module (the platform subscription of an organization: plans, the
 * lifecycle from trial to cancelled, payments through the gateway, statements, usage and the
 * overage cap). Other modules and the composition root import from here only.
 *
 * The subscriptions track (Track A, S6.01 and S6.03 to S6.07) fills the seam skeleton of Stage 6 in.
 * The gateway is the `paymentsGateway` port of the adapter resolver
 * (`application/ports.ts` says how it must be called: it is not idempotent, and a request can still
 * be in flight after the caller gave up). The routes sit behind the `subscriptions` feature, so a
 * single-tenant deployment has none.
 */
import type { FastifyInstance } from 'fastify';

import type { AdapterResolver } from '../../main/adapter-resolver.js';
import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../platform/http/public-origin.js';
import type { RateLimitStore } from '../../platform/http/rate-limit.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import type { EmailSender } from '../../platform/mail/email-sender.js';
import type { ExportRegistry, TenantCancelledPort } from '../tenancy/index.js';

import { exportSubscriptions } from './application/export-contributor.js';
import type { SubscriptionDeps } from './application/provider.js';
import { gatewayOf, isSimulated } from './application/provider.js';
import { subscriptionRoutes } from './http/subscription-routes.js';
import { subscriptionWebhookRoutes } from './http/webhook-routes.js';

export { createSubscriptionPlanImpact } from './application/plan-impact.js';
export { createQuotaPolicy } from './application/quota-policy.js';
export { takesProfessionalSeat } from './domain/active-professional.js';
export { assertProfessionalSeatAvailable } from './application/seats.js';
export { createTrialStarter } from './application/trial.js';
// The services the platform demo (`pnpm demo:platform`) drives, as the jobs and routes do.
export { startCheckout } from './application/checkout.js';
export { runDunningStep, runTrialEnd } from './application/clock.js';
export { reconcileSubscription } from './application/reconcile.js';
export { generateStatements } from './application/statements.js';
export { runUsageSnapshot } from './application/usage.js';
// The billing calendar (a period is a calendar month of Argentina), for what lays dates out on it.
export { BILLING_ZONE, dayOf, periodBounds, periodOf, previousPeriod } from './domain/periods.js';
export type { StartTrialResult, TrialStarter } from './application/trial.js';
export { subscriptionOperatorRoutes } from './http/operator-routes.js';
export {
  createSubscriptionJobs,
  DUNNING_STEP_JOB,
  STATEMENT_GENERATE_JOB,
  SUBSCRIPTION_RECONCILE_JOB,
  TRIAL_END_JOB,
  USAGE_SNAPSHOT_JOB,
} from './jobs/subscription-jobs.js';
export type { SubscriptionDeps } from './application/provider.js';
export { isSimulated } from './application/provider.js';
export type * from './application/ports.js';

/** Registers what subscriptions takes with an organization that leaves: its statements. */
export function registerSubscriptionsExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'subscriptions', exportSubscriptions);
}

export interface SubscriptionsOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** Sends the notices to the owner (trial end, dunning, statements): no patient data in them. */
  email: EmailSender;
  /** Where emailed links point (never the Host header of a request). */
  origins: PublicOrigins;
  rateLimitStore?: RateLimitStore | undefined;
  /** Queues the billing jobs. Absent when no module needs the queue. */
  jobs?: JobClient | undefined;
  /** Which gateway serves which organization (`forTenant(PLATFORM, 'paymentsGateway')`). */
  adapters?: AdapterResolver | undefined;
  /** Says an organization was cancelled (the subscription reaching its end publishes through it). */
  tenantCancelled: TenantCancelledPort;
  clock?: () => Date;
  /** How long a call to the provider is waited for before its outcome counts as unknown (20 s). */
  providerTimeoutMs?: number | undefined;
}

export interface Subscriptions {
  /** What the module was built with; the track builds its services from it. */
  readonly options: SubscriptionsOptions;
  /** The HTTP routes of the module (behind the `subscriptions` feature). */
  routes: (app: FastifyInstance) => void;
}

/** The services of the module are built with this: what the composition root offers. */
export function depsOf(options: SubscriptionsOptions): SubscriptionDeps {
  return {
    withTenant: options.withTenant,
    adapters: options.adapters,
    jobs: options.jobs,
    email: options.email,
    origins: options.origins,
    tenantCancelled: options.tenantCancelled,
    clock: options.clock ?? (() => new Date()),
    providerTimeoutMs: options.providerTimeoutMs,
  };
}

export function createSubscriptions(options: SubscriptionsOptions): Subscriptions {
  const deps = depsOf(options);
  const registerOwnerRoutes = subscriptionRoutes({
    deps,
    simulated: () => isSimulated(gatewayOf(deps)),
  });
  const registerWebhook = subscriptionWebhookRoutes({
    withTenant: options.withTenant,
    gateway: () => gatewayOf(deps),
    jobs: options.jobs,
    clock: deps.clock,
    providerTimeoutMs: options.providerTimeoutMs,
  });
  return {
    options,
    routes: (app) => {
      registerOwnerRoutes(app);
      registerWebhook(app);
    },
  };
}
