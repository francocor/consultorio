/**
 * The shape of the declaration every public route of the product makes about how it protects itself
 * (`public-routes.test.ts`). It lives in its own file so a stage can declare its routes in a file of
 * its own (`stage6-public-routes.ts`) without editing the test.
 */

/** How a public route protects itself. A route may use several. */
export type Guard =
  /** Says nothing about anybody: the look of an organization, a puzzle. */
  | 'open-metadata'
  /** Reached by the public slug of a link; every address that is not live answers the same. */
  | 'link-slug'
  /** The bot challenge in front of the form: a puzzle solved once. */
  | 'bot-challenge'
  /** The anonymous session that made the hold. */
  | 'hold-session'
  /** The one-time code sent to the address in the form: ten minutes, five tries. */
  | 'otp'
  /** A single-purpose link: unknown, expired, spent and revoked all look alike. */
  | 'token'
  /** The signature of the provider, checked over the raw bytes. */
  | 'signature'
  /** Per-address bounds (a limit of the route, and the abuse counters of the flow). */
  | 'rate-limit';

export interface Declaration {
  guards: readonly Guard[];
  /** The test files that probe it. */
  probes: readonly string[];
}
