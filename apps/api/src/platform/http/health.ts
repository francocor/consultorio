import { HealthResponse } from '@consultorio/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { errorCode, type DbCheckResult } from '../db/probe.js';

export interface HealthDeps {
  /** Reports whether the database is reachable. A rejection counts as unreachable. */
  checkDatabase(): Promise<DbCheckResult>;
}

/**
 * `/health` is liveness: the process is up and serving.
 * `/ready` is readiness: the process can reach the database. A failed check is logged as a warning
 * with the error code only.
 */
export function healthRoutes(deps: HealthDeps): FastifyPluginCallbackZod {
  return (app, _options, done) => {
    app.get(
      '/health',
      { config: { readOnly: 'read' }, schema: { response: { 200: HealthResponse } } },
      () => ({
        status: 'ok' as const,
      }),
    );

    app.get(
      '/ready',
      {
        config: { readOnly: 'read' },
        schema: { response: { 200: HealthResponse, 503: HealthResponse } },
      },
      async (request, reply) => {
        const result = await deps
          .checkDatabase()
          .catch((error: unknown): DbCheckResult => ({ ok: false, code: errorCode(error) }));
        if (!result.ok) {
          request.log.warn({ code: result.code }, 'readiness check failed: database unreachable');
          return reply.code(503).send({ status: 'unavailable' });
        }
        return { status: 'ok' as const };
      },
    );

    done();
  };
}
