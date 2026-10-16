/**
 * Public API of the identity module: accounts, sessions and sign-in. Other modules and the
 * composition root import from here only.
 */
import { SYSTEM_USER_ID, type WithTenant } from '../../platform/db/tenant-context.js';
import type { Authenticate } from '../../platform/http/auth-guard.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { createAttemptThrottle } from './application/attempt-throttle.js';
import { exportStaff } from './application/export-contributor.js';
import { createLockout, DEFAULT_LOCKOUT, type LockoutPolicy } from './application/lockout.js';
import { createLoginService, type LoginService } from './application/login.js';
import { createSessionService, type SessionService } from './application/sessions.js';
import { authRoutes } from './http/auth-routes.js';
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
  /** Verifies a session token on a tenant; plugged into the platform authentication guard. */
  authenticate: Authenticate;
  /** The HTTP routes of sign-in, sign-out and session management. */
  routes: ReturnType<typeof authRoutes>;
}

export function createIdentity(options: IdentityOptions): Identity {
  const hasher = options.hasher ?? createPasswordHasher();
  const sessions = createSessionService(options.clock ? { clock: options.clock } : {});
  const policy = options.lockout ?? DEFAULT_LOCKOUT;
  const clock = options.clock ? { clock: options.clock } : {};
  const lockout = createLockout({ policy, ...clock });
  const login = createLoginService({
    withTenant: options.withTenant,
    hasher,
    sessions,
    lockout,
    // Unknown identifiers meet the same delays and the same lock as real accounts.
    accountThrottle: createAttemptThrottle({
      lockAfter: policy.maxFailures,
      lockMs: policy.lockMs,
      ...clock,
    }),
    // A clinic shares one address, so a client is only delayed, and only after many failures.
    clientThrottle: createAttemptThrottle({ freeFailures: 10, ...clock }),
    ...(options.clock ? { clock: options.clock } : {}),
  });

  return {
    sessions,
    login,
    hasher,
    // The guard looks the session up before it knows the user, so it acts as the system.
    authenticate: (token, tenantId) =>
      options.withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) => sessions.resolve(tx, token)),
    routes: authRoutes({
      withTenant: options.withTenant,
      login,
      sessions,
      cookieSecure: options.cookieSecure,
      ...(options.loginRateLimit ? { loginRateLimit: options.loginRateLimit } : {}),
    }),
  };
}
