import type { FastifyInstance } from 'fastify';

import type { AdapterResolver } from '../../../main/adapter-resolver.js';
import type { AuthzOptions } from '../../../platform/authz/guard.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { RateLimitStore } from '../../../platform/http/rate-limit.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import type { TrialStarter } from '../../subscriptions/index.js';

/**
 * Self-service signup of Stage 6 (tenant-onboarding, Part B): a visitor creates an organization, it
 * stays `unverified` until the emailed link is followed, and the trial starts only then. It exists
 * in multi mode only: the routes sit behind the `signup` feature.
 *
 * Seam skeleton: the module is registered through the onboarding `index.ts` and does nothing yet.
 * The signup track (Track B, S6.02 and S6.07) adds files under this folder and edits this one. The
 * response of a signup is the same whether or not the name or the email already existed (F11), the
 * bot challenge is the `botChallenge` port, and the purge (`signup.purge`, seven days) is the second
 * retention exception: it never touches a verified organization.
 */

export interface SignupOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** Encrypts what the new organization needs a key for. */
  keys: TenantKeys;
  /** Sends the verification link and the notice to the owner of an existing email. */
  email: EmailSender;
  /** Where emailed links point (never the Host header of a request). */
  origins: PublicOrigins;
  /** The counters of the throttles of the public form. */
  rateLimitStore: RateLimitStore;
  /** Queues the retry of a verification email and the purge. */
  jobs?: JobClient | undefined;
  /** Resolves the bot challenge of the form (`forTenant(PLATFORM, 'botChallenge')`). */
  adapters?: AdapterResolver | undefined;
  /** Starts the trial of an organization that just verified its address (`subscriptions`, S6.01). */
  trial: TrialStarter;
  clock?: () => Date;
}

export interface Signup {
  /** What the module was built with; the track builds its services from it. */
  readonly options: SignupOptions;
  /** The HTTP routes of the module (behind the `signup` feature). */
  routes: (app: FastifyInstance) => void;
}

export function createSignup(options: SignupOptions): Signup {
  return { options, routes: () => undefined };
}
