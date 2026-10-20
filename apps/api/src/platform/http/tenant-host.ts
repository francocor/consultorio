import type { FastifyInstance } from 'fastify';

import { denied } from './problem.js';

/** The fields of a tenant that every request needs. Anything else is read inside `withTenant`. */
export interface ResolvedTenant {
  id: string;
  slug: string;
  status: 'active' | 'read_only' | 'cancelled' | 'unverified';
  readOnlySince: Date | null;
  isDemo: boolean;
  country: string;
}

/** What the request's host says it is: a tenant, or the platform operator console. */
export type HostContext = { kind: 'tenant'; tenant: ResolvedTenant } | { kind: 'platform' };

/** Resolves a Host header. Null means "no such host": the caller answers the generic 404. */
export type ResolveHost = (hostHeader: string | undefined) => Promise<HostContext | null>;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the host guard on every route except the exempt ones. */
    hostContext: HostContext | null;
  }
}

/**
 * Paths that answer on any host: infrastructure probes and provider webhooks, which cannot know
 * which tenant host to use. Webhooks identify their tenant from the signed payload instead.
 */
const HOST_EXEMPT = [/^\/health$/, /^\/ready$/, /^\/webhooks\//];

function isExempt(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return HOST_EXEMPT.some((pattern) => pattern.test(path));
}

/**
 * Registers the host guard. The tenant comes from the `Host` header only (design, ADR-002): a
 * body, query or `X-Tenant-Id` header never selects a tenant. An unknown host and a host whose
 * tenant does not exist get the same generic 404 as an unknown route.
 *
 * The session check that follows (S1.10) compares the session's tenant with this one and answers
 * 401 on a mismatch.
 */
export function registerTenantHost(app: FastifyInstance, resolveHost: ResolveHost): void {
  app.decorateRequest('hostContext', null);

  app.addHook('onRequest', async (request, reply) => {
    if (isExempt(request.url)) return;
    const context = await resolveHost(request.headers.host);
    if (context === null) {
      return denied(request, reply);
    }
    request.hostContext = context;
  });
}
