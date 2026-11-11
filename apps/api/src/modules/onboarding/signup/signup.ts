import type { FastifyInstance } from 'fastify';

import type { AdapterResolver } from '../../../main/adapter-resolver.js';
import type { AuthzOptions } from '../../../platform/authz/guard.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Db } from '../../../platform/db/pool.js';
import { createWithTenant, type WithTenant } from '../../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { RateLimitStore } from '../../../platform/http/rate-limit.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { createActionTokens } from '../../../platform/tokens/index.js';
import type { PasswordHasher, PasswordValidator, SessionService } from '../../identity/index.js';
import type { TrialStarter } from '../../subscriptions/index.js';

import { createSignupHousekeeping, type SignupHousekeeping } from './application/housekeeping.js';
import { createVerificationMailer } from './application/mailer.js';
import { createSignupService, type SignupService } from './application/service.js';
import { signupRoutes } from './http/signup-routes.js';

/**
 * Self-service signup of Stage 6 (tenant-onboarding, Part B): a visitor creates an organization, it
 * stays `unverified` until the emailed link is followed, and the trial starts only then. It exists
 * in multi mode only: the routes sit behind the `signup` feature.
 *
 * The response of a signup is the same whether or not the name or the email already existed (F11),
 * the bot challenge is the `botChallenge` port, and the purge (`signup.purge`, seven days) is the
 * second retention exception: it never touches a verified organization.
 */

/** What the signup needs from identity to create the first owner (the wiring context offers it). */
export interface SignupAccounts {
  passwordValidator: PasswordValidator;
  hasher: PasswordHasher;
  sessions: SessionService;
  /** True when the session cookie carries `Secure` (the deployment is served over https). */
  cookieSecure: boolean;
}

export interface SignupOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** Encrypts what the new organization needs a key for (its data key is made on activation). */
  keys: TenantKeys;
  /** Sends the verification link and the notice to the owner of an existing email. */
  email: EmailSender;
  /** Where emailed links point (never the Host header of a request). */
  origins: PublicOrigins;
  /** The counters of the throttles of the public form. */
  rateLimitStore: RateLimitStore;
  /** Kept for the wiring that offers it; the retry of the email is a pass of the worker. */
  jobs?: JobClient | undefined;
  /** Resolves the bot challenge of the form (`forTenant(PLATFORM, 'botChallenge')`). */
  adapters?: AdapterResolver | undefined;
  /** Starts the trial of an organization that just verified its address (`subscriptions`, S6.01). */
  trial: TrialStarter;
  /** The password rules, the hasher and the sessions of identity. */
  accounts: SignupAccounts;
  clock?: () => Date;
  /** The id of a new organization; replaceable in tests. */
  newTenantId?: () => string;
  /** The random part of an address that collided; replaceable in tests. */
  slugSuffix?: () => string;
}

export interface Signup {
  /** What the module was built with. */
  readonly options: SignupOptions;
  /** The service behind the routes, for the tests of the module. */
  readonly service: SignupService;
  /** The HTTP routes of the module (behind the `signup` feature). */
  routes: (app: FastifyInstance) => void;
}

export function createSignup(options: SignupOptions): Signup {
  const clock = options.clock ?? (() => new Date());
  const tokens = createActionTokens({ clock });
  const mailer = createVerificationMailer({
    withTenant: options.withTenant,
    tokens,
    email: options.email,
    origins: options.origins,
    clock,
  });
  const service = createSignupService({
    withTenant: options.withTenant,
    hasher: options.accounts.hasher,
    validator: options.accounts.passwordValidator,
    tokens,
    keys: options.keys,
    store: options.rateLimitStore,
    email: options.email,
    mailer,
    trial: options.trial,
    sessions: options.accounts.sessions,
    clock,
    ...(options.newTenantId ? { newTenantId: options.newTenantId } : {}),
    ...(options.slugSuffix ? { slugSuffix: options.slugSuffix } : {}),
  });
  return {
    options,
    service,
    routes: signupRoutes({
      service,
      adapters: options.adapters,
      cookieSecure: options.accounts.cookieSecure,
    }),
  };
}

export interface SignupWorkerOptions {
  /** The runtime connection of the worker. */
  db: Db;
  email: EmailSender;
  origins: PublicOrigins;
  clock?: () => Date;
  /** Where a failure of the retry is told: a code only. */
  onError: (code: string) => void;
}

/**
 * The passes of the worker that belong to the signup: the purge of the signups nobody confirmed and
 * the retry of the verification emails. Both work across organizations, so they are not jobs of an
 * organization (see `SignupHousekeeping`).
 */
export function createSignupWorker(options: SignupWorkerOptions): SignupHousekeeping {
  const clock = options.clock ?? (() => new Date());
  return createSignupHousekeeping({
    db: options.db,
    mailer: createVerificationMailer({
      withTenant: createWithTenant(options.db),
      tokens: createActionTokens({ clock }),
      email: options.email,
      origins: options.origins,
      clock,
    }),
    clock,
    onError: options.onError,
  });
}
