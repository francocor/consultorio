/**
 * Bot challenge of the public forms (design 4.5, "Turnstile on hold and submission"). A port, so
 * the product runs on a local proof-of-work puzzle today and on Cloudflare Turnstile later.
 */

export interface BotChallengeToken {
  /** Which solver the browser needs, such as `pow` or `turnstile`. */
  kind: string;
  /** What the solver needs (a puzzle, a site key). Public by design. */
  payload: Readonly<Record<string, unknown>>;
}

export interface BotChallenge {
  /** A fresh challenge for one form submission, for the address that asks for it. */
  issue(ip: string): Promise<BotChallengeToken>;
  /** True when the proof solves a challenge this adapter issued, once. `ip` binds the proof. */
  verify(proof: string, ip: string): Promise<boolean>;
}
