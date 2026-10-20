import type { FastifyInstance } from 'fastify';

import type { FeatureKey } from '../../platform/features.js';
import type { FeatureRoutes } from '../server.js';

import type { ModuleWiring, OperatorWiringContext } from './types.js';

/**
 * Joins the routes that modules put behind a feature (`ModuleWiring.create().featureRoutes`) into
 * one registration per feature, which is what `buildServer` takes. Several modules may sit behind
 * the same feature (subscriptions and the operator view of it, signup and its purge): their handlers
 * run in the order the modules were wired.
 */
export function mergeFeatureRoutes(
  parts: readonly (Partial<Record<FeatureKey, FeatureRoutes>> | undefined)[],
): Partial<Record<FeatureKey, FeatureRoutes>> {
  const byFeature = new Map<FeatureKey, FeatureRoutes[]>();
  for (const part of parts) {
    for (const [feature, routes] of Object.entries(part ?? {}) as [FeatureKey, FeatureRoutes][]) {
      byFeature.set(feature, [...(byFeature.get(feature) ?? []), routes]);
    }
  }
  const merged: Partial<Record<FeatureKey, FeatureRoutes>> = {};
  for (const [feature, handlers] of byFeature) {
    merged[feature] = async (app) => {
      for (const handler of handlers) await handler(app);
    };
  }
  return merged;
}

/**
 * The routes that modules add inside the operator console, in the order the modules were wired.
 * Each module is built with the same context (the operator connection, the lifecycle door, the
 * mail and the links).
 */
export function operatorExtensionsOf(
  wirings: readonly ModuleWiring[],
  context: OperatorWiringContext,
): ((app: FastifyInstance) => void)[] {
  return wirings.flatMap((wiring) => {
    const routes = wiring.operatorRoutes?.(context);
    return routes ? [routes] : [];
  });
}
