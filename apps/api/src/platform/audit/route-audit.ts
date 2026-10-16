import type { AuditAction } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * The audit actions a state-changing route writes. A route that changes nothing worth an audit
     * entry says `'none'`. The audit-coverage policy test fails a mutating route that declares
     * neither, so a new endpoint cannot ship without a decision about its audit trail.
     */
    audits?: readonly AuditAction[] | 'none';
  }
  interface FastifyInstance {
    /** "METHOD /url" -> what the route declares it audits (undefined when it declares nothing). */
    routeAudits: Map<string, readonly AuditAction[] | 'none' | undefined>;
  }
}

/** Records the `audits` declaration of every route, for the audit-coverage policy test. */
export function registerRouteAudits(app: FastifyInstance): void {
  const audits = new Map<string, readonly AuditAction[] | 'none' | undefined>();
  app.decorate('routeAudits', audits);
  app.addHook('onRoute', (route) => {
    const declared = route.config?.audits;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) audits.set(`${method} ${route.url}`, declared);
  });
}
