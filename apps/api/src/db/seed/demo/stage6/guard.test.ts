import { describe, expect, it } from 'vitest';

import { platformDemoRefusal } from './guard.js';

describe('the guard of pnpm demo:platform', () => {
  const development = { nodeEnv: 'development', deploymentMode: 'multi', baseDomain: 'localhost' };

  it('lets a development database with several organizations through', () => {
    expect(platformDemoRefusal(development)).toBeNull();
  });

  it('refuses production, whatever else is configured', () => {
    expect(platformDemoRefusal({ ...development, nodeEnv: 'production' })).toMatch(
      /never runs in production/,
    );
  });

  it('refuses a single-tenant deployment and one without a base domain, where there is no platform to demonstrate', () => {
    expect(platformDemoRefusal({ ...development, deploymentMode: 'single' })).toMatch(
      /DEPLOYMENT_MODE=multi/,
    );
    expect(platformDemoRefusal({ nodeEnv: 'development', deploymentMode: 'multi' })).toMatch(
      /BASE_DOMAIN/,
    );
  });

  it('says why in the first place that applies: production before the rest', () => {
    expect(platformDemoRefusal({ nodeEnv: 'production', deploymentMode: 'single' })).toMatch(
      /never runs in production/,
    );
  });
});
