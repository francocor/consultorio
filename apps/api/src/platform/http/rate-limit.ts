import { isIPv6 } from 'node:net';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { AppError } from './problem.js';

/**
 * Where request counters live. In memory while there is one API instance; a Postgres or Valkey
 * implementation of this interface replaces it at two or more instances (design 4.5). Counters
 * are best-effort protection against floods, never an audit record.
 */
export interface RateLimitStore {
  /** Counts one request for `key` in a window of `windowMs`, and reports the state afterwards. */
  hit(key: string, windowMs: number): Promise<{ count: number; resetsInMs: number }>;
}

interface Window {
  count: number;
  startedAt: number;
  windowMs: number;
}

export function createMemoryRateLimitStore(
  options: { now?: () => number; maxKeys?: number } = {},
): RateLimitStore {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 50_000;
  const windows = new Map<string, Window>();

  return {
    hit(key, windowMs) {
      const at = now();
      const known = windows.get(key);
      const current: Window =
        known && known.startedAt + known.windowMs > at
          ? { ...known, count: known.count + 1 }
          : { count: 1, startedAt: at, windowMs };

      // Re-inserting keeps the Map in least-recently-used order, so eviction drops the idlest key.
      windows.delete(key);
      windows.set(key, current);
      while (windows.size > maxKeys) {
        const oldest = windows.keys().next().value;
        if (oldest === undefined) break;
        windows.delete(oldest);
      }
      return Promise.resolve({
        count: current.count,
        resetsInMs: current.startedAt + current.windowMs - at,
      });
    },
  };
}

export interface RateLimit {
  max: number;
  windowMs: number;
}

export interface RateLimitSettings {
  store: RateLimitStore;
  /** Per client address, inside one tenant. */
  perClient: RateLimit;
  /**
   * For the whole tenant, whatever the addresses. The routes with no account (`auth: 'public'`)
   * count in a bucket of their own with the same allowance.
   */
  perTenant: RateLimit;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** A stricter (or looser) limit for one route, counted apart from the default one. */
    rateLimit?: { max: number; timeWindow: number };
  }
}

/** The tenant of the request's host, or `platform` / `none` where there is no tenant. */
function tenantKeyOf(request: FastifyRequest): string {
  const context = request.hostContext;
  if (context?.kind === 'tenant') return context.tenant.id;
  return context?.kind ?? 'none';
}

/**
 * Clients of one IPv6 /64 are one client (a single subscriber gets a whole /64, so counting full
 * addresses would let them dodge the limit). IPv4 and IPv4-mapped IPv6 addresses count as is.
 */
export function clientKeyOf(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (!isIPv6(ip)) return ip;
  const groups = expandIPv6(ip);
  return `${groups.slice(0, 4).join(':')}::/64`;
}

function expandIPv6(ip: string): string[] {
  const [head = '', tail] = ip.split('::');
  const first = head === '' ? [] : head.split(':');
  const last = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = 8 - first.length - last.length;
  const groups =
    tail === undefined ? first : [...first, ...Array<string>(missing).fill('0'), ...last];
  return groups.map((group) => group.toLowerCase().replace(/^0+(?=.)/, ''));
}

/** Probes must keep answering under load, or the load balancer pulls the instance. */
const EXEMPT = /^\/(?:health|ready)$/;

/**
 * Rate limits requests per client address inside a tenant, and per tenant overall. Exceeding
 * either limit answers 429 `rate_limited` (problem+json) with `Retry-After`. A route can set its
 * own limit with `config: { rateLimit: { max, timeWindow } }`; it counts apart from the default.
 *
 * It is a plain `onRequest` hook registered synchronously (not a plugin), so it runs in the order
 * it is registered and no route can be added without it. Register it after the tenant host guard
 * and BEFORE the authentication guard, so floods are cut before they cost a session lookup.
 * Both keys include the tenant: one tenant's traffic never uses up another tenant's allowance.
 * If the store fails the request is let through (availability first) and the failure is logged.
 */
export function registerRateLimit(app: FastifyInstance, settings: RateLimitSettings): void {
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (EXEMPT.test(path)) return;

    const tenant = tenantKeyOf(request);
    const override = request.routeOptions.config.rateLimit;
    const clientLimit: RateLimit = override
      ? { max: override.max, windowMs: override.timeWindow }
      : settings.perClient;
    const clientKey = override
      ? `route|${request.method} ${request.routeOptions.url ?? ''}|${tenant}|${clientKeyOf(request.ip)}`
      : `client|${tenant}|${clientKeyOf(request.ip)}`;

    // The public routes (visitors with no account) have an allowance of their own: a flood of
    // them must not use up the one the staff of the same organization work with.
    const isPublic = request.routeOptions.config.auth === 'public';
    const checks: [string, RateLimit][] = [
      [clientKey, clientLimit],
      [isPublic ? `tenant-public|${tenant}` : `tenant|${tenant}`, settings.perTenant],
    ];
    for (const [key, limit] of checks) {
      let state: { count: number; resetsInMs: number };
      try {
        state = await settings.store.hit(key, limit.windowMs);
      } catch (error) {
        request.log.warn(
          { code: (error as { code?: unknown } | null)?.code },
          'rate limit store failed',
        );
        return;
      }
      if (state.count > limit.max) {
        void reply.header('retry-after', String(Math.max(1, Math.ceil(state.resetsInMs / 1000))));
        throw new AppError('rate_limited');
      }
    }
  });
}

/**
 * How many times more than its per-tenant allowance a client may send before ANY host is looked
 * up. A real client of one organization never gets near it; a scan of invented subdomains does.
 */
const HOST_PROBE_FACTOR = 4;

/**
 * Counts every request of a client, whichever host it names, BEFORE the tenant behind the host is
 * looked up. Without it, a client rotating invented subdomains costs the database one query each
 * while every per-tenant limit sees nothing (an unknown host has no tenant to count against).
 * Register it before the tenant host guard. Probes are exempt, and a store failure lets the
 * request through, like the other limits.
 */
export function registerHostProbeLimit(app: FastifyInstance, settings: RateLimitSettings): void {
  const limit: RateLimit = {
    max: settings.perClient.max * HOST_PROBE_FACTOR,
    windowMs: settings.perClient.windowMs,
  };
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (EXEMPT.test(path)) return;

    let state: { count: number; resetsInMs: number };
    try {
      state = await settings.store.hit(`host-probe|${clientKeyOf(request.ip)}`, limit.windowMs);
    } catch (error) {
      request.log.warn(
        { code: (error as { code?: unknown } | null)?.code },
        'rate limit store failed',
      );
      return;
    }
    if (state.count > limit.max) {
      void reply.header('retry-after', String(Math.max(1, Math.ceil(state.resetsInMs / 1000))));
      throw new AppError('rate_limited');
    }
  });
}
