export type DeploymentMode = 'multi' | 'single';

/** Capabilities that exist only on a multi-tenant platform. */
export const FEATURES = ['signup', 'subscriptions', 'operator_console'] as const;
export type FeatureKey = (typeof FEATURES)[number];

export interface FeatureRegistry {
  isEnabled(feature: FeatureKey): boolean;
}

/**
 * Which capabilities a deployment has, decided by `DEPLOYMENT_MODE` alone. A single-tenant
 * instance hosts one organization that the operator provisions, so self-service signup, platform
 * subscriptions and the operator console do not exist there. Everything else is identical: one
 * build, one image, two modes.
 */
const BY_MODE: Record<DeploymentMode, Record<FeatureKey, boolean>> = {
  multi: { signup: true, subscriptions: true, operator_console: true },
  single: { signup: false, subscriptions: false, operator_console: false },
};

export function createFeatureRegistry(mode: DeploymentMode): FeatureRegistry {
  const enabled = BY_MODE[mode];
  return { isEnabled: (feature) => enabled[feature] };
}
