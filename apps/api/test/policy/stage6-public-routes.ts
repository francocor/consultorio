import type { Declaration } from './public-route-declaration.js';

/**
 * How each public route of Stage 6 protects itself, and which test probes it (merged into the list
 * of `public-routes.test.ts`). The tracks add their routes here and edit nothing shared:
 *
 * - Track B (signup): `POST /public/signup` (guards `bot-challenge`, `rate-limit`; a probe that the
 *   answer is the same for a name or an email already in use) and `POST /public/signup/verify` and
 *   `POST /public/signup/resend` (guards `token`, `rate-limit`);
 * - Track A (subscriptions): `POST /webhooks/mercadopago` (guard `signature`; a probe that a forged,
 *   a stale and a duplicate notice change nothing).
 *
 * Every entry names test files that exist (the test checks it), and a route under `/public/` or
 * `/webhooks/` with no entry fails the test: that is the point.
 */
const SIGNUP = 'test/integration/signup.test.ts';
const SIGNUP_ABUSE = 'test/security/signup-abuse.test.ts';

export const STAGE6_PUBLIC_ROUTES: Readonly<Record<string, Declaration>> = {
  // Track A: the notice of the payments provider. The signature of the raw body and its window come
  // first; the probes prove a forged, an altered, an unsigned and a stale notice change nothing, and
  // that a repeated one is recorded once.
  'POST /webhooks/mercadopago': {
    guards: ['signature', 'rate-limit'],
    probes: ['test/integration/mp-webhook.test.ts'],
  },
  // The challenge of the form, from the platform host or from the page of an unverified organization.
  'GET /public/signup/challenge': {
    guards: ['open-metadata', 'rate-limit'],
    probes: [SIGNUP, SIGNUP_ABUSE],
  },
  // Track B, signup. The form asks for the challenge and counts per client, per address and overall;
  // the answer is the same whether the name or the address was in use (`signup-abuse.test.ts` proves
  // it by the answers, the emails and the number of statements).
  'POST /public/signup': {
    guards: ['bot-challenge', 'rate-limit'],
    probes: [SIGNUP, SIGNUP_ABUSE],
  },
  'POST /public/signup/resend': {
    guards: ['bot-challenge', 'rate-limit'],
    probes: [SIGNUP, SIGNUP_ABUSE],
  },
  // From the page of a link that expired: the organization is the host's, the body names nobody.
  'POST /public/signup/renew': {
    guards: ['bot-challenge', 'rate-limit'],
    probes: [SIGNUP, SIGNUP_ABUSE],
  },
  // The verification link: unknown, expired, spent and replaced all look alike.
  'POST /public/signup/verify': {
    guards: ['token', 'rate-limit'],
    probes: [SIGNUP, SIGNUP_ABUSE],
  },
  // Retention (track C): the single-use link of a break-glass release, 72 hours. Looking at it spends
  // nothing; the POST spends it and hands the package over once. Unknown, expired, spent and foreign
  // links all answer the same.
  'GET /public/:slug/archive-release/:token': {
    guards: ['token', 'rate-limit'],
    probes: ['test/integration/archive-release.test.ts'],
  },
  'POST /public/:slug/archive-release/:token': {
    guards: ['token', 'rate-limit'],
    probes: ['test/integration/archive-release.test.ts'],
  },
};
