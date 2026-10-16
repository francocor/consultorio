/**
 * Public API of the identity module: accounts, sessions and sign-in. Other modules and the
 * composition root import from here only.
 */
import type { FastifyInstance } from 'fastify';

import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import { SYSTEM_USER_ID, type WithTenant } from '../../platform/db/tenant-context.js';
import type { Authenticate } from '../../platform/http/auth-guard.js';
import type { RateLimitStore } from '../../platform/http/rate-limit.js';
import type { EmailSender } from '../../platform/mail/email-sender.js';
import { createActionTokens } from '../../platform/tokens/index.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { createAttemptThrottle } from './application/attempt-throttle.js';
import { exportStaff } from './application/export-contributor.js';
import {
  createInvitationAcceptance,
  createInvitations,
  type Invitations,
} from './application/invitations.js';
import { createLockout, DEFAULT_LOCKOUT, type LockoutPolicy } from './application/lockout.js';
import { createLoginService, type LoginService } from './application/login.js';
import { createPasswordReset } from './application/password-reset.js';
import { createReauthentication } from './application/reauthentication.js';
import { createSecondFactorLogin } from './application/second-factor-login.js';
import { createSessionService, type SessionService } from './application/sessions.js';
import { createTwoFactor } from './application/two-factor.js';
import type { PasswordValidator } from './domain/password-policy.js';
import { authRoutes } from './http/auth-routes.js';
import { recoveryRoutes } from './http/recovery-routes.js';
import { twoFactorRoutes } from './http/two-factor-routes.js';
import { createPasswordHasher, type PasswordHasher } from './infrastructure/argon2.js';

/** Registers what identity contributes to the cancellation export. */
export function registerIdentityExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'identity', exportStaff);
}

export { createPasswordHasher } from './infrastructure/argon2.js';
export type { PasswordHasher } from './infrastructure/argon2.js';
export type { SessionService } from './application/sessions.js';

export interface IdentityOptions {
  withTenant: WithTenant;
  /** Envelope encryption: second-factor secrets are stored encrypted with the tenant key. */
  keys: TenantKeys;
  /** Transactional email: password reset links. */
  email: EmailSender;
  /** Checks new passwords (length, common passwords, optional breach check). */
  passwordValidator: PasswordValidator;
  /** Counters shared with the rest of the API, here for the reset emails per account. */
  rateLimitStore: RateLimitStore;
  cookieSecure: boolean;
  clock?: () => Date;
  hasher?: PasswordHasher;
  lockout?: LockoutPolicy;
  loginRateLimit?: { max: number; timeWindow: number };
}

export interface Identity {
  sessions: SessionService;
  login: LoginService;
  hasher: PasswordHasher;
  /** Issues staff invitation links (the staff module sends them). */
  invitations: Invitations;
  /** Verifies a session token on a tenant; plugged into the platform authentication guard. */
  authenticate: Authenticate;
  /** The HTTP routes of sign-in, sign-out and session management. */
  routes: (app: FastifyInstance) => void;
}

export function createIdentity(options: IdentityOptions): Identity {
  const hasher = options.hasher ?? createPasswordHasher();
  const policy = options.lockout ?? DEFAULT_LOCKOUT;
  const clock = options.clock ? { clock: options.clock } : {};
  const sessions = createSessionService(clock);
  const lockout = createLockout({ policy, ...clock });
  const twoFactor = createTwoFactor({
    keys: options.keys,
    withTenant: options.withTenant,
    ...clock,
  });
  // A clinic shares one address, so a client is only delayed, and only after many failures.
  const clientThrottle = createAttemptThrottle({ freeFailures: 10, ...clock });

  const login = createLoginService({
    withTenant: options.withTenant,
    hasher,
    sessions,
    lockout,
    twoFactor,
    // Unknown identifiers meet the same delays and the same lock as real accounts.
    accountThrottle: createAttemptThrottle({
      lockAfter: policy.maxFailures,
      lockMs: policy.lockMs,
      ...clock,
    }),
    clientThrottle,
    ...clock,
  });
  const secondFactorLogin = createSecondFactorLogin({
    withTenant: options.withTenant,
    twoFactor,
    lockout,
    sessions,
    clientThrottle,
    ...clock,
  });
  const reauth = createReauthentication({ hasher, lockout });
  const tokens = createActionTokens(clock);
  const passwordReset = createPasswordReset({
    withTenant: options.withTenant,
    tokens,
    sessions,
    hasher,
    validator: options.passwordValidator,
    lockout,
    email: options.email,
    limits: options.rateLimitStore,
    ...clock,
  });
  const invitationAcceptance = createInvitationAcceptance({
    withTenant: options.withTenant,
    tokens,
    hasher,
    validator: options.passwordValidator,
    ...clock,
  });
  const loginRateLimit = options.loginRateLimit ? { loginRateLimit: options.loginRateLimit } : {};

  const mainRoutes = authRoutes({
    withTenant: options.withTenant,
    login,
    sessions,
    twoFactor,
    cookieSecure: options.cookieSecure,
    ...loginRateLimit,
  });
  const factorRoutes = twoFactorRoutes({
    withTenant: options.withTenant,
    twoFactor,
    reauth,
    sessions,
    secondFactorLogin,
    cookieSecure: options.cookieSecure,
    ...loginRateLimit,
  });

  const recovery = recoveryRoutes({
    withTenant: options.withTenant,
    passwordReset,
    invitations: invitationAcceptance,
    secureLinks: options.cookieSecure,
    ...loginRateLimit,
  });

  return {
    sessions,
    login,
    hasher,
    invitations: createInvitations({ tokens, ...clock }),
    // The guard looks the session up before it knows the user, so it acts as the system.
    authenticate: (token, tenantId) =>
      options.withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) => sessions.resolve(tx, token)),
    routes: (app) => {
      mainRoutes(app);
      factorRoutes(app);
      recovery(app);
    },
  };
}
