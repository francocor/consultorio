/**
 * Public API of the identity module: accounts, sessions and sign-in. Other modules and the
 * composition root import from here only.
 */
import { SYSTEM_USER_ID, type WithTenant } from '../../platform/db/tenant-context.js';
import type { Authenticate } from '../../platform/http/auth-guard.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportStaff } from './application/export-contributor.js';
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
  const login = createLoginService({
    withTenant: options.withTenant,
    hasher,
    sessions,
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
    }),
  };
}
