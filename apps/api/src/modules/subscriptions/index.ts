/**
 * Public API of the subscriptions module (the platform subscription of an organization: plans, the
 * lifecycle from trial to cancelled, payments through the gateway, statements, usage and the
 * overage cap). Other modules and the composition root import from here only.
 *
 * This is the seam skeleton of Stage 6: the module is wired and registered, and does nothing yet.
 * The subscriptions track (Track A, S6.01 and S6.03 to S6.07) adds files under this folder and
 * edits this one. The gateway is the `paymentsGateway` port of the adapter resolver
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
import { unbuiltTrialStarter, type TrialStarter } from './application/trial.js';

export { createSubscriptionPlanImpact } from './application/plan-impact.js';
export { createQuotaPolicy } from './application/quota-policy.js';
export type { StartTrialResult, TrialStarter } from './application/trial.js';
export type * from './application/ports.js';

/** The trial door for the signup. Seam: refuses until S6.01 builds the real one. */
export function createTrialStarter(): TrialStarter {
  return unbuiltTrialStarter;
}

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
}

export interface Subscriptions {
  /** What the module was built with; the track builds its services from it. */
  readonly options: SubscriptionsOptions;
  /** The HTTP routes of the module (behind the `subscriptions` feature). */
  routes: (app: FastifyInstance) => void;
}

export function createSubscriptions(options: SubscriptionsOptions): Subscriptions {
  return { options, routes: () => undefined };
}
