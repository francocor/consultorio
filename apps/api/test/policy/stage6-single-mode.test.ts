import { afterAll, describe, expect, it } from 'vitest';

import { createRuntimeDb } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';

/**
 * A single-tenant deployment has no signup and no platform subscription (tenancy, "Single-tenant
 * mode"; subscriptions, "Single-tenant deployments"): the routes that exist only to onboard and bill
 * organizations are registered behind the feature registry, and this test reads the real application
 * to prove none of them is served in single mode. It lists prefixes, not routes, so a route a track
 * adds later is covered without editing this file.
 *
 * - `/public/signup` and `/public/signup/*`: the visitor's form and the verification link;
 * - `/subscription` and `/subscription/*`: the owner's view and actions;
 * - `/webhooks/mercadopago`: the payments provider's notice;
 * - `/local-providers/mercadopago/*`: the hosted checkout of the local simulator.
 *
 * The operator console is multi-only already (`operator_console`), so `/operator/*` needs no entry.
 */
const BILLING_AND_SIGNUP_PREFIXES = [
  /^\/public\/signup(\/|$)/,
  /^\/subscription(\/|$)/,
  /^\/webhooks\/mercadopago$/,
  /^\/local-providers\/mercadopago(\/|$)/,
];

const database = createRuntimeDb('postgres://app_rw:unused@127.0.0.1:1/unused');

async function routes(mode: 'multi' | 'single'): Promise<string[]> {
  const app = buildTestApplication(database, {
    ...(mode === 'single'
      ? {
          deployment: { mode: 'single' as const, slug: 'test-tenant' },
          publicUrl: 'https://agenda.clinica.example',
        }
      : {}),
  });
  await app.ready();
  const found = [...app.routeCategories.keys()];
  await app.close();
  return found;
}

afterAll(async () => {
  await database.close();
});

const pathOf = (route: string) => route.slice(route.indexOf(' ') + 1);
const isBillingOrSignup = (route: string) =>
  BILLING_AND_SIGNUP_PREFIXES.some((prefix) => prefix.test(pathOf(route)));

describe('a single-tenant deployment has no signup and no subscription routes', () => {
  it('serves none of them in single mode', async () => {
    const served = await routes('single');

    expect(served.length).toBeGreaterThan(40);
    expect(served.filter(isBillingOrSignup)).toEqual([]);
  });

  it('only takes routes away in single mode: everything it serves, multi mode serves too', async () => {
    const multi = new Set(await routes('multi'));
    const single = await routes('single');

    expect(single.filter((route) => !multi.has(route))).toEqual([]);
  });

  it('recognises the routes it is looking for (the check proves itself)', () => {
    for (const route of [
      'POST /public/signup',
      'POST /public/signup/verify',
      'GET /subscription',
      'POST /subscription/checkout',
      'POST /webhooks/mercadopago',
      'GET /local-providers/mercadopago/checkout/:id',
    ]) {
      expect(isBillingOrSignup(route), route).toBe(true);
    }
    for (const route of [
      'GET /subscriptions-are-not-this',
      'POST /public/:slug/booking/holds',
      'POST /webhooks/erx',
      'GET /public/signupish',
    ]) {
      expect(isBillingOrSignup(route), route).toBe(false);
    }
  });
});
