import {
  ROUTE_CATEGORIES,
  isAllowedWhenReadOnly,
  type RouteCategory,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { AppError, denied } from '../http/problem.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Read-only category of the route. Mandatory: a route without one fails at boot. */
    readOnly?: RouteCategory;
  }
  interface FastifyInstance {
    /** "METHOD /url" -> category, for every registered route. Used by the route policy test. */
    routeCategories: Map<string, RouteCategory>;
  }
}

/**
 * Public booking and waitlist pages. In a read-only tenant they look exactly like a disabled
 * link (the generic "not available" response), not like a payment problem the visitor can do
 * nothing about. Covers `/public/{slug}/booking/*`, `/public/{slug}/p/*` and `/public/{slug}/waitlist`.
 */
const PUBLIC_BOOKING_PREFIX = /^\/public\/[^/]+\/(?:booking|p|waitlist)(?:\/|$)/;

function isKnownCategory(value: unknown): value is RouteCategory {
  return ROUTE_CATEGORIES.some((category) => category === value);
}

/**
 * For a route that stays open when the tenant is read-only because part of what it does protects
 * the patient (category `patient_protective`), while the rest does not: call it for the part that
 * does not. In a tenant that is not active it refuses with 402 `tenant_read_only`, exactly as the
 * policy refuses a plain write; in an active one it does nothing.
 */
export function refuseWhenReadOnly(request: FastifyRequest): void {
  const context = request.hostContext;
  if (context?.kind === 'tenant' && context.tenant.status !== 'active') {
    throw new AppError('tenant_read_only');
  }
}

/**
 * Registers the read-only policy (tenancy, "Read-only tenant and its allowlist").
 *
 * 1. Boot: every route must declare `config: { readOnly: <category> }`. The `onRoute` hook throws
 *    for a route without one, so a new route cannot ship uncategorized.
 * 2. Request: when the tenant of the request is not active, a route whose category is not on the
 *    shared allowlist is refused with 402 `tenant_read_only`. Public booking and waitlist routes
 *    answer with the generic "not available" response instead.
 *
 * It must be registered AFTER the tenant host guard (it reads `request.hostContext`) and BEFORE
 * any route. A cancelled tenant is gated like a read-only one: its data stays readable and its
 * allowlisted actions (export, authentication, opt-out) keep working.
 */
export function registerReadOnlyPolicy(app: FastifyInstance): void {
  const categories = new Map<string, RouteCategory>();
  app.decorate('routeCategories', categories);

  app.addHook('onRoute', (route) => {
    const category: unknown = route.config?.readOnly;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!isKnownCategory(category)) {
      throw new Error(
        `Route ${methods.join(',')} ${route.url} must declare config.readOnly with a known category`,
      );
    }
    for (const method of methods) categories.set(`${method} ${route.url}`, category);
  });

  app.addHook('onRequest', async (request, reply) => {
    const context = request.hostContext;
    if (context?.kind !== 'tenant' || context.tenant.status === 'active') return;
    if (request.is404) return;

    const path = request.url.split('?')[0] ?? request.url;
    if (PUBLIC_BOOKING_PREFIX.test(path)) {
      return denied(request, reply);
    }

    const category = request.routeOptions.config.readOnly;
    if (category === undefined || !isAllowedWhenReadOnly(category)) {
      throw new AppError('tenant_read_only');
    }
  });
}
