import { HealthResponse } from '@consultorio/contracts';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

export interface HealthDeps {
  /** Resolves true when the database is reachable. A rejection counts as unreachable. */
  checkDatabase(): Promise<boolean>;
}

/**
 * `/health` is liveness: the process is up and serving.
 * `/ready` is readiness: the process can reach the database.
 */
export function healthRoutes(deps: HealthDeps): FastifyPluginCallbackZod {
  return (app, _options, done) => {
    app.get('/health', { schema: { response: { 200: HealthResponse } } }, () => ({
      status: 'ok' as const,
    }));

    app.get(
      '/ready',
      { schema: { response: { 200: HealthResponse, 503: HealthResponse } } },
      async (_request, reply) => {
        const databaseUp = await deps.checkDatabase().catch(() => false);
        if (!databaseUp) {
          return reply.code(503).send({ status: 'unavailable' });
        }
        return { status: 'ok' as const };
      },
    );

    done();
  };
}
