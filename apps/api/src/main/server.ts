import type { Writable } from 'node:stream';

import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import {
  createResolveHost,
  type DeploymentSettings,
  type LookupTenant,
} from '../modules/tenancy/index.js';
import { registerRequestContext } from '../platform/audit/request-context.js';
import { registerRouteAudits } from '../platform/audit/route-audit.js';
import { createFeatureRegistry, type FeatureKey } from '../platform/features.js';
import { registerAuthGuard, type AuthGuardOptions } from '../platform/http/auth-guard.js';
import { registerBackgroundTasks } from '../platform/http/background.js';
import { registerOriginCheck } from '../platform/http/csrf-origin.js';
import { healthRoutes, type HealthDeps } from '../platform/http/health.js';
import {
  generateRequestId,
  registerProblemHandlers,
  registerRequestId,
} from '../platform/http/problem.js';
import { registerRateLimit, type RateLimitSettings } from '../platform/http/rate-limit.js';
import { registerSecurityHeaders } from '../platform/http/security-headers.js';
import { registerTenantHost } from '../platform/http/tenant-host.js';
import { registerReadOnlyPolicy } from '../platform/read-only/index.js';

import { buildLoggerOptions } from './logger.js';

/** Registers the routes of a capability. Called only when the deployment has that capability. */
export type FeatureRoutes = (app: FastifyInstance) => void | Promise<void>;

export interface BuildServerOptions {
  logLevel?: string;
  /** Destination for log lines. Defaults to stdout. Tests pass a capturing stream. */
  logStream?: Writable;
  health: HealthDeps;
  /** How hosts map to tenants. Comes from configuration; see `deploymentFromConfig`. */
  deployment: DeploymentSettings;
  /** Finds a tenant by slug before any tenant context exists. */
  lookupTenant: LookupTenant;
  /** Routes of the multi-tenant-only capabilities, registered only when the mode enables them. */
  featureRoutes?: Partial<Record<FeatureKey, FeatureRoutes>>;
  /** True behind a load balancer: the client address then comes from X-Forwarded-For. */
  trustProxy?: boolean;
  /**
   * Session authentication. When present, every route must declare `config.auth` and protected
   * routes require a session; state-changing requests also pass the Origin check. The real
   * application always supplies it (see `createApplication`); only tests of unrelated pieces omit it.
   */
  auth?: AuthGuardOptions;
  /** Request limits per client and per tenant. Registered before authentication. */
  rateLimit?: RateLimitSettings;
  /** Routes of the capabilities every deployment has (identity, access, ...). */
  routes?: readonly FeatureRoutes[];
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const loggerOptions = buildLoggerOptions(options.logLevel ?? 'info');

  const app = Fastify({
    logger: options.logStream ? { ...loggerOptions, stream: options.logStream } : loggerOptions,
    genReqId: generateRequestId,
    // The request id is always generated here; a client-supplied one is never trusted.
    requestIdHeader: false,
    trustProxy: options.trustProxy ?? false,
  });

  registerRequestId(app);
  registerSecurityHeaders(app, { secure: options.auth?.cookieSecure ?? false });
  registerBackgroundTasks(app);
  registerRequestContext(app);
  registerProblemHandlers(app);
  registerTenantHost(app, createResolveHost(options.deployment, options.lookupTenant));
  // After the host guard (it reads the tenant) and before any route (it checks their categories).
  registerReadOnlyPolicy(app);
  registerRouteAudits(app);
  if (options.rateLimit) registerRateLimit(app, options.rateLimit);
  if (options.auth) {
    registerOriginCheck(app);
    registerAuthGuard(app, options.auth);
  }

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  void app.register(healthRoutes(options.health));

  for (const routes of options.routes ?? []) {
    void app.register(async (scope) => {
      await routes(scope);
    });
  }

  const features = createFeatureRegistry(options.deployment.mode);
  for (const [feature, routes] of Object.entries(options.featureRoutes ?? {}) as [
    FeatureKey,
    FeatureRoutes,
  ][]) {
    if (features.isEnabled(feature)) {
      void app.register(async (scope) => {
        await routes(scope);
      });
    }
  }

  return app;
}
