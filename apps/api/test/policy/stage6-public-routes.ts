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
export const STAGE6_PUBLIC_ROUTES: Readonly<Record<string, Declaration>> = {};
