import type { Writable } from 'node:stream';

import { fail } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';

import { createAccess, createGrants, createGrantsRepo } from '../modules/access/index.js';
import type { LockoutPolicy } from '../modules/identity/application/lockout.js';
import type { PasswordValidator } from '../modules/identity/domain/password-policy.js';
import { createIdentity, type PasswordHasher } from '../modules/identity/index.js';
import { createPatients } from '../modules/patients/index.js';
import { createStaff } from '../modules/staff/index.js';
import { createTenantLookup, type DeploymentSettings } from '../modules/tenancy/index.js';
import { createAuditDeny } from '../platform/audit/deny.js';
import { createActorLoader } from '../platform/authz/guard.js';
import {
  type MatriculaValidator,
  type ProfessionalRepo,
} from '../platform/authz/professional-gate.js';
import { createCatalogReader } from '../platform/country/catalog-reader.js';
import { getCountryPack } from '../platform/country/country-pack.js';
import type { TenantKeys } from '../platform/crypto/tenant-keys.js';
import type { Db, DbHandle } from '../platform/db/pool.js';
import { createWithTenant } from '../platform/db/tenant-context.js';
import type { HealthDeps } from '../platform/http/health.js';
import { createMemoryRateLimitStore, type RateLimit } from '../platform/http/rate-limit.js';
import type { EmailSender } from '../platform/mail/email-sender.js';

import { buildServer, type FeatureRoutes } from './server.js';

export interface ApplicationOptions {
  /** The runtime database (connects as `app_rw`). */
  database: Pick<DbHandle, 'db'>;
  health: HealthDeps;
  deployment: DeploymentSettings;
  logLevel?: string;
  logStream?: Writable;
  trustProxy: boolean;
  cookieSecure: boolean;
  /** Per-tenant data keys: second-factor secrets are stored encrypted with them. */
  keys: TenantKeys;
  email: EmailSender;
  passwordValidator: PasswordValidator;
  /** Replaceable in tests; production uses the system clock. */
  clock?: () => Date;
  hasher?: PasswordHasher;
  lockout?: LockoutPolicy;
  /** Request limits; defaults protect a single instance. Tests raise them. */
  limits?: Partial<RequestLimits>;
  /** Professional profiles for the clinical gate. The staff module provides them (S1.19). */
  professionals?: ProfessionalRepo;
  /** Routes of the capability modules, registered after identity. */
  modules?: readonly FeatureRoutes[];
}

export interface RequestLimits {
  perClient: RateLimit;
  perTenant: RateLimit;
  /** Sign-in attempts per client address and tenant. */
  login: { max: number; timeWindow: number };
}

const DEFAULT_LIMITS: RequestLimits = {
  perClient: { max: 300, windowMs: 60_000 },
  perTenant: { max: 6000, windowMs: 60_000 },
  login: { max: 20, timeWindow: 60_000 },
};

/**
 * Wires the application: the tenant host guard, authentication and the routes of every
 * capability that exists in all deployments. `main` and the integration tests both build the
 * server here, so a test exercises exactly the composition that production runs, and
 * authentication cannot be left out of it.
 */
export function createApplication(options: ApplicationOptions): FastifyInstance {
  const db: Db = options.database.db;
  // The server exists only after this function builds it, but a denial that cannot be recorded
  // must be reported through its logger.
  const built: { server?: FastifyInstance } = {};
  const limits: RequestLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const withTenant = createWithTenant(db);
  const rateLimitStore = createMemoryRateLimitStore();

  // Grants are read fresh on every request, so a revocation takes effect with the next call.
  const grants = createGrants();
  const grantsRepo = createGrantsRepo(withTenant, grants);

  const identity = createIdentity({
    withTenant,
    grants: grantsRepo,
    keys: options.keys,
    email: options.email,
    passwordValidator: options.passwordValidator,
    rateLimitStore,
    cookieSecure: options.cookieSecure,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.hasher ? { hasher: options.hasher } : {}),
    ...(options.lockout ? { lockout: options.lockout } : {}),
    loginRateLimit: limits.login,
  });

  // Format check of the matricula comes from the country pack. Only Argentina exists today; with
  // a second country the validator is chosen by the tenant's country.
  const pack = getCountryPack('AR', createCatalogReader(db));
  const validateMatricula: MatriculaValidator = (jurisdiction, value) =>
    pack.ok && pack.value.validateMatricula(jurisdiction, value).ok;
  const auditDeny = createAuditDeny({
    db,
    alert: (alert) => {
      built.server?.log.error(
        { alert: alert.kind, action: alert.action, code: alert.errorCode },
        'an access denial could not be recorded in the audit log',
      );
    },
  });

  const access = createAccess({
    withTenant,
    auditDeny,
    sessions: identity.sessions,
    grants,
    defaultTimeZone: (country) => {
      const found = getCountryPack(country, createCatalogReader(db));
      return found.ok
        ? found.value.defaults.timeZone
        : pack.ok
          ? pack.value.defaults.timeZone
          : 'UTC';
    },
  });

  const staff = createStaff({
    withTenant,
    auditDeny,
    invitations: identity.invitations,
    sessions: identity.sessions,
    email: options.email,
    secureLinks: options.cookieSecure,
    matriculaRules: (country, jurisdiction, value) => {
      const found = getCountryPack(country, createCatalogReader(db));
      return found.ok
        ? found.value.validateMatricula(jurisdiction, value)
        : fail('errors.unsupported_country');
    },
  });

  const patients = createPatients({
    withTenant,
    auditDeny,
    ...(options.clock ? { clock: options.clock } : {}),
    majorityAge: (country) => {
      const found = getCountryPack(country, createCatalogReader(db));
      return found.ok ? found.value.majorityAge : 18;
    },
    documents: (country, type, value) => {
      const found = getCountryPack(country, createCatalogReader(db));
      return found.ok
        ? found.value.validateDocument(type, value)
        : fail('errors.unsupported_country');
    },
  });

  const server = buildServer({
    ...(options.logLevel === undefined ? {} : { logLevel: options.logLevel }),
    ...(options.logStream ? { logStream: options.logStream } : {}),
    health: options.health,
    deployment: options.deployment,
    trustProxy: options.trustProxy,
    rateLimit: {
      store: rateLimitStore,
      perClient: limits.perClient,
      perTenant: limits.perTenant,
    },
    lookupTenant: createTenantLookup(db),
    auth: {
      authenticate: identity.authenticate,
      cookieSecure: options.cookieSecure,
      authz: {
        loadActor: createActorLoader({
          professionals: options.professionals ?? staff.professionals,
          grants: grantsRepo,
          validateMatricula,
        }),
        auditDeny,
      },
    },
    routes: [
      identity.routes,
      access.routes,
      staff.routes,
      patients.routes,
      ...(options.modules ?? []),
    ],
  });
  built.server = server;
  return server;
}
