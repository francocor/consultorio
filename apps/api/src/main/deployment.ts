import type { DeploymentSettings } from '../modules/tenancy/index.js';

import type { Config } from './config.js';

/**
 * Turns the validated configuration into the settings the tenancy module understands. The config
 * schema already guarantees that multi mode has its domains and single mode has its slug.
 */
export function deploymentFromConfig(config: Config): DeploymentSettings {
  if (config.deploymentMode === 'single') {
    return { mode: 'single', slug: config.singleTenantSlug ?? '' };
  }
  return {
    mode: 'multi',
    baseDomain: config.baseDomain ?? '',
    platformHost: config.platformHost ?? '',
  };
}
