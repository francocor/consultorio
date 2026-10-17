/**
 * Public API of the operator module: the platform operator console. Operators are not tenant
 * users; they sign in on the platform host with a password and a mandatory authenticator code,
 * and they reach tenant data only through a database role with an allowlist of privileges.
 */
import type { FastifyInstance } from 'fastify';

import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { Db } from '../../platform/db/pool.js';
import type { PublicOrigins } from '../../platform/http/public-origin.js';
import type { EmailSender } from '../../platform/mail/email-sender.js';
import type { PasswordHasher } from '../identity/index.js';

import { createOperatorAuth } from './application/auth.js';
import { createOperatorRun } from './application/context.js';
import { createOperatorHolidays } from './application/holidays.js';
import { createOperatorAdmin, type OperatorAdmin } from './application/operators.js';
import { createOperatorSupport } from './application/support.js';
import { createOperatorTenants, type DemoResetPort } from './application/tenants.js';
import { operatorRoutes } from './http/operator-routes.js';
import type { OperatorSecrets } from './infrastructure/secrets.js';

export { createOperatorSecrets } from './infrastructure/secrets.js';
export type { OperatorSecrets } from './infrastructure/secrets.js';
export { unavailableDemoReset } from './application/tenants.js';
export type { DemoResetPort } from './application/tenants.js';
export type { OperatorAdmin } from './application/operators.js';

/** Creates operator accounts without the HTTP side: the bootstrap command and the tests. */
export function createOperatorAdminFor(options: {
  db: Db;
  hasher: PasswordHasher;
  secrets: OperatorSecrets;
}): OperatorAdmin {
  return createOperatorAdmin({ run: createOperatorRun(options.db), ...options });
}

export interface OperatorOptions {
  /** The connection of the `app_operator` role. Never the runtime one. */
  db: Db;
  secrets: OperatorSecrets;
  /** Creates the data key of a new organization. */
  keys: TenantKeys;
  hasher: PasswordHasher;
  email: EmailSender;
  /** Where an organization's emailed links point. */
  origins: PublicOrigins;
  secureLinks: boolean;
  loginRateLimit?: { max: number; timeWindow: number };
  /** The privileged reset of a demo organization (the demo module provides it, S1.36). */
  demoReset?: DemoResetPort;
  clock?: () => Date;
  slugSuffix?: () => string;
}

export interface OperatorConsole {
  /** The HTTP routes, registered only on the platform host. */
  routes: (app: FastifyInstance) => void;
  /** Creates operator accounts: the bootstrap command and the tests, never an endpoint. */
  admin: OperatorAdmin;
}

export function createOperatorConsole(options: OperatorOptions): OperatorConsole {
  const run = createOperatorRun(options.db);
  const clock = options.clock ? { clock: options.clock } : {};

  const auth = createOperatorAuth({
    run,
    hasher: options.hasher,
    secrets: options.secrets,
    ...clock,
  });
  const tenants = createOperatorTenants({
    run,
    keys: options.keys,
    ...(options.demoReset ? { demoReset: options.demoReset } : {}),
    ...(options.slugSuffix ? { slugSuffix: options.slugSuffix } : {}),
    ...clock,
  });
  const support = createOperatorSupport({ run });
  const holidays = createOperatorHolidays({ run });

  return {
    routes: operatorRoutes({
      auth,
      tenants,
      support,
      holidays,
      email: options.email,
      origins: options.origins,
      secureLinks: options.secureLinks,
      loginRateLimit: options.loginRateLimit ?? { max: 10, timeWindow: 60_000 },
    }),
    admin: createOperatorAdmin({ run, hasher: options.hasher, secrets: options.secrets }),
  };
}
