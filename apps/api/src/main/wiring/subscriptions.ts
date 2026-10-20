import { createFakePaymentsGateway } from '../../adapters/mercadopago-fake/index.js';
import type { FakePaymentsGateway } from '../../adapters/mercadopago-fake/index.js';
import {
  createSubscriptions,
  subscriptionOperatorRoutes,
} from '../../modules/subscriptions/index.js';
import { adapterOfSetting } from '../../platform/local-providers/dev-routes.js';
import { fake } from '../adapter-resolver.js';
import type { Config } from '../config.js';

import type { ModuleWiring } from './types.js';

/**
 * The in-memory fake that serves the demo organizations. One per configuration, so the adapter
 * registry and the provider console, which are both built from the same `config`, hold the same
 * one: the console can put the demo gateway in a mode (an outage, a lost answer) and the demo uses
 * it. A demo organization is billing-exempt and never subscribes, so this slot exists for the guard
 * of the adapter resolver ("a demo organization never reaches a real service") and for the demo
 * seed, not for a flow.
 */
const demoGateways = new WeakMap<Config, FakePaymentsGateway>();
export function demoPaymentsGatewayOf(config: Config): FakePaymentsGateway {
  let gateway = demoGateways.get(config);
  if (!gateway) {
    gateway = createFakePaymentsGateway();
    demoGateways.set(config, gateway);
  }
  return gateway;
}

/**
 * Everything the subscriptions module registers with the composition root (Track A). The track
 * edits this file, `modules/subscriptions/` and nothing shared: it fills the customer slot of the
 * `paymentsGateway` port when its local Mercado Pago exists (`adapters/mercadopago-local`, marked
 * `fake()`), adds the simulator controls to its console entry, adds its jobs to the worker
 * (`trial.end`, `dunning.step`, `usage.snapshot`, `statement.generate`, `subscription.reconcile`),
 * mounts its routes behind the `subscriptions` feature (`featureRoutes`) and its views in the
 * operator console (`operatorRoutes`). Its permission (`billing.manage`), audit actions, queues and
 * the doors the other modules call (`createQuotaPolicy`, `createSubscriptionPlanImpact`,
 * `createTrialStarter`) already exist.
 */
export const subscriptionsWiring: ModuleWiring = {
  name: 'subscriptions',
  // No customer gateway yet: nobody can subscribe; demo organizations get the fake.
  adapters: ({ config }) => ({
    paymentsGateway: { real: undefined, demo: fake(demoPaymentsGatewayOf(config)) },
  }),
  devProviders: ({ config }) => [
    {
      id: 'payments',
      label: 'Mercado Pago',
      // The simulator adds its mode (ok, down, refuse_amount_change, ...) when it exists.
      status: () =>
        Promise.resolve({ adapter: adapterOfSetting(config.providers.payments), mode: null }),
    },
  ],
  // A checkout, a plan change and the cancellation are made in a request and followed up by jobs.
  needsJobs: true,
  // The support view of the subscriptions, inside the operator console (behind its session).
  operatorRoutes: (context) => subscriptionOperatorRoutes({ run: context.run }),
  create: (context) => {
    const subscriptions = createSubscriptions({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      email: context.email,
      origins: context.origins,
      rateLimitStore: context.rateLimitStore,
      jobs: context.jobs,
      adapters: context.adapters,
      tenantCancelled: context.tenantLifecycle,
      ...(context.clock ? { clock: context.clock } : {}),
    });
    return { featureRoutes: { subscriptions: subscriptions.routes } };
  },
};
