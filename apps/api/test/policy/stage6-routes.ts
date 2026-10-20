import type { RouteCategory } from '@consultorio/contracts';

/**
 * The read-only category of every route of Stage 6 (signup, the subscription and its payments, the
 * cancellation export and the retention archive), decided once and written down (tenancy,
 * "Read-only tenant and its allowlist"; subscriptions, "Dunning and read-only"; the archive release).
 *
 * - `read`: a screen, a list, or the statement of the period. It keeps working when the organization
 *   is read-only: the owner has to see why, and what to pay.
 * - `subscription`: what the owner does about the account itself (subscribe, change the plan, retry
 *   a payment, cancel, reactivate, set the cap of the overage). A read-only organization is read-only
 *   BECAUSE of the account, so the way out of it can never be closed by it.
 * - `export`: the packages of the cancellation export and the single-use link of a release. An
 *   organization that leaves must be able to take its records, in every state.
 * - `webhook`: the notice of Mercado Pago, signed with the secret of the deployment.
 * - `auth`: the steps of a signup. They are public, run on the platform host or in an organization
 *   nobody has confirmed yet, and nothing in them touches an active organization.
 * - `write`: everything else that changes data. The routes of the operator console are filed here
 *   too (the console is the platform's and the tenant policy does not apply to it).
 *
 * A route of these modules that is not in this table fails `route-categories.test.ts`; that is the
 * point: the person who adds it has to decide, here, whether it may run in a read-only organization.
 * HEAD routes are derived from the GET ones and are not listed. The routes of the local simulator
 * (`/local-providers/mercadopago/*` and `/operator/dev/payments/*`) exist only while the console of
 * local providers is on and are enumerated by `provider-console-routes.test.ts`.
 */
export const STAGE6_ROUTES: Readonly<Record<string, RouteCategory>> = {
  // The subscription of the organization (permission `billing.manage`, owner only).
  'GET /subscription': 'read',
  'GET /subscription/plan-impact': 'read',
  'GET /subscription/plans': 'read',
  'GET /subscription/usage': 'read',
  'GET /subscription/statements': 'read',
  'GET /subscription/statements/:id': 'read',
  'GET /subscription/statements/:id/document': 'read',
  'POST /subscription/checkout': 'subscription',
  'POST /subscription/plan': 'subscription',
  'POST /subscription/cancel': 'subscription',
  'POST /subscription/reactivate': 'subscription',
  'POST /subscription/retry-payment': 'subscription',
  'PATCH /subscription/overage-cap': 'subscription',
  // The notice of Mercado Pago.
  'POST /webhooks/mercadopago': 'webhook',
  // Signup: a visitor, a code from the bot challenge, and a link by email.
  'GET /public/signup/challenge': 'read',
  'POST /public/signup': 'auth',
  'POST /public/signup/resend': 'auth',
  'POST /public/signup/renew': 'auth',
  'POST /public/signup/verify': 'auth',
  // The cancellation export: the owner takes the administrative package, each professional their own.
  'GET /cancellation/export/administrative': 'read',
  'GET /cancellation/export/clinical': 'read',
  'POST /cancellation/export/administrative/download': 'export',
  'POST /cancellation/export/clinical/download': 'export',
  // The link of a release from the archive: single use, 72 hours.
  'GET /public/:slug/archive-release/:token': 'export',
  'POST /public/:slug/archive-release/:token': 'export',
  // The operator console: support view of the subscriptions, usage, the end of an organization and
  // the break-glass release. No route of it returns the content of an archive.
  'GET /operator/subscriptions': 'read',
  'GET /operator/usage': 'read',
  'GET /operator/tenants/:id/subscription': 'read',
  'POST /operator/tenants/:tenantId/cancel': 'write',
  'GET /operator/archives': 'read',
  'GET /operator/archive-releases': 'read',
  'POST /operator/archive-releases': 'write',
  'POST /operator/archive-releases/:id/verify-identity': 'write',
  'POST /operator/archive-releases/:id/approve': 'write',
  'POST /operator/archive-releases/:id/reject': 'write',
};

/**
 * What a request that changes nothing may be filed as. The page of a release link only looks at
 * whether the link still works, and belongs to the records that leave (`export`), so it answers in
 * every state of the organization.
 */
const READS: readonly RouteCategory[] = ['read', 'export'];

const EXACT = [
  /^\/subscription(\/|$)/,
  /^\/webhooks\/mercadopago$/,
  /^\/public\/signup(\/|$)/,
  /^\/cancellation\//,
  /^\/public\/:slug\/archive-release\//,
  /^\/operator\/(subscriptions|usage|archives|archive-releases)(\/|$)/,
  /^\/operator\/tenants\/:id\/subscription$/,
  /^\/operator\/tenants\/:tenantId\/cancel$/,
];

/** True for a route key ("METHOD /url") that belongs to Stage 6. */
export function isStage6Route(key: string): boolean {
  const path = key.slice(key.indexOf(' ') + 1);
  return EXACT.some((pattern) => pattern.test(path));
}

function methodOf(key: string): string {
  return key.slice(0, key.indexOf(' '));
}

/**
 * What is wrong with the Stage 6 routes the application registered, in this order: routes missing
 * from the table, routes of the table that are not registered, routes filed in another category
 * than the table says, and routes that change data but sit in the `read` category (a read-only
 * organization could call them).
 */
export function findStage6RouteProblems(registered: ReadonlyMap<string, RouteCategory>): string[] {
  const unknown: string[] = [];
  const missing: string[] = [];
  const wrong: string[] = [];
  const writesFiledAsReads: string[] = [];

  for (const [key, category] of registered) {
    if (!isStage6Route(key)) continue;
    const method = methodOf(key);
    if (method === 'HEAD') {
      if (!READS.includes(category)) {
        wrong.push(`${key} is filed as "${category}" but a HEAD request only reads`);
      }
      continue;
    }
    const expected = STAGE6_ROUTES[key];
    if (expected === undefined) {
      unknown.push(`${key} is registered but not in the table of Stage 6 routes`);
    } else if (expected !== category) {
      wrong.push(`${key} is filed as "${category}" but the table says "${expected}"`);
    }
    if (method !== 'GET' && category === 'read') {
      writesFiledAsReads.push(
        `${key} changes data and is filed as "read", which a read-only organization may call`,
      );
    }
  }
  for (const key of Object.keys(STAGE6_ROUTES)) {
    if (!registered.has(key)) missing.push(`${key} is in the table but not registered`);
  }
  return [...unknown, ...missing, ...wrong, ...writesFiledAsReads];
}
