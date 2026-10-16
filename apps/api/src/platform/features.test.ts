import { describe, expect, it } from 'vitest';

import { buildServer } from '../main/server.js';
import { testTenancy } from '../testing/tenancy.js';

import { FEATURES, createFeatureRegistry } from './features.js';

describe('feature registry', () => {
  it('enables signup, subscriptions and the operator console in multi mode', () => {
    const features = createFeatureRegistry('multi');

    expect(features.isEnabled('signup')).toBe(true);
    expect(features.isEnabled('subscriptions')).toBe(true);
    expect(features.isEnabled('operator_console')).toBe(true);
  });

  it('disables signup, subscriptions and the operator console in single mode', () => {
    const features = createFeatureRegistry('single');

    expect(features.isEnabled('signup')).toBe(false);
    expect(features.isEnabled('subscriptions')).toBe(false);
    expect(features.isEnabled('operator_console')).toBe(false);
  });

  it('answers true or false for every feature in both modes', () => {
    for (const mode of ['multi', 'single'] as const) {
      const features = createFeatureRegistry(mode);
      for (const feature of FEATURES) {
        expect(typeof features.isEnabled(feature), `${mode}/${feature}`).toBe('boolean');
      }
    }
  });
});

describe('the same build boots in both modes from configuration only', () => {
  function bootWith(mode: 'multi' | 'single') {
    return buildServer({
      logLevel: 'silent',
      health: { checkDatabase: () => Promise.resolve({ ok: true }) },
      ...testTenancy(),
      deployment:
        mode === 'multi'
          ? {
              mode: 'multi',
              baseDomain: 'consultorio.test',
              platformHost: 'platform.consultorio.test',
            }
          : { mode: 'single', slug: 'test-tenant' },
      featureRoutes: {
        signup: (app) => {
          app.post('/public/signup', () => ({ created: true }));
        },
        subscriptions: (app) => {
          app.get('/subscription', () => ({ plan: 'basic' }));
        },
      },
    });
  }

  it('serves health in multi mode and exposes the signup and subscription routes', async () => {
    const app = bootWith('multi');

    const health = await app.inject({ url: '/health', headers: { host: 'x.example' } });
    const signup = await app.inject({
      method: 'POST',
      url: '/public/signup',
      headers: { host: 'platform.consultorio.test' },
    });

    expect(health.statusCode).toBe(200);
    expect(signup.statusCode).toBe(200);
    expect(signup.json()).toEqual({ created: true });
    await app.close();
  });

  it('serves health in single mode and does not register the signup or subscription routes', async () => {
    const app = bootWith('single');

    const health = await app.inject({ url: '/health' });
    const signup = await app.inject({ method: 'POST', url: '/public/signup' });
    const subscription = await app.inject({ url: '/subscription' });
    await app.ready();

    expect(health.statusCode).toBe(200);
    expect(signup.statusCode).toBe(404);
    expect(subscription.statusCode).toBe(404);
    expect(app.hasRoute({ method: 'POST', url: '/public/signup' })).toBe(false);
    await app.close();
  });
});
