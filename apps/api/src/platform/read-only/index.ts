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
    /**
     * True for a route that an UNVERIFIED organization (a signup nobody confirmed yet) still serves:
     * the verification link and the request for a new one. Every other route of such an organization
     * answers like a route that does not exist.
     */
    unverifiedAllowed?: boolean;
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

/**
 * The two documents the page of an unverified organization draws itself from (its name, its look).
 * They belong to the tenancy module, which does not know the signup, so they are named here.
 */
const UNVERIFIED_OPEN_PATHS = ['/public/boot', '/manifest.webmanifest'] as const;

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
    // An organization nobody confirmed yet is not an organization: it answers only the routes made
    // for it, and everything else looks like a route that does not exist.
    if (context.tenant.status === 'unverified') {
      const open =
        request.routeOptions.config.unverifiedAllowed === true ||
        UNVERIFIED_OPEN_PATHS.some((allowed) => allowed === path);
      return open ? undefined : denied(request, reply);
    }
    if (PUBLIC_BOOKING_PREFIX.test(path)) {
      return denied(request, reply);
    }

    const category = request.routeOptions.config.readOnly;
    if (category === undefined || !isAllowedWhenReadOnly(category)) {
      throw new AppError('tenant_read_only');
    }
  });
}
