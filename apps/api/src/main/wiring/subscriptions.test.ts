import { describe, expect, it } from 'vitest';

import { createFakeEmailSender } from '../../adapters/fake-email/index.js';
import type { Config } from '../config.js';

import { publicBaseUrlOf, subscriptionsWiring } from './subscriptions.js';

const config = (overrides: Record<string, unknown>) =>
  ({
    cookieSecure: true,
    platformHost: 'platform.consultorio.test',
    providers: {},
    ...overrides,
  }) as unknown as Config;

describe('the worker of the subscriptions', () => {
  const context = (deploymentMode: 'multi' | 'single') => ({
    config: config({ deploymentMode, publicUrl: 'https://aillu.consultorio.test' }),
    adapters: { forTenant: () => undefined },
    email: createFakeEmailSender(),
  });

  it('only meters in a single-tenant deployment: there is nobody to bill, but the counts are kept', () => {
    const contribution = subscriptionsWiring.worker?.(context('single') as never);
    const queues = (definitions: readonly { name: string }[] | undefined) =>
      definitions?.map((definition) => definition.name);

    const jobs = contribution?.jobs?.({ client: {}, db: {}, log: {} } as never);
    expect(queues(jobs as never)).toEqual(['usage.snapshot']);
    const schedules = contribution?.schedules?.({ client: {}, db: {} } as never);
    expect(schedules?.map((schedule) => schedule.name)).toEqual(['usage.snapshot tick']);
  });

  it('has the jobs of the subscription and the clocks that drive them in a multi-tenant one', () => {
    const contribution = subscriptionsWiring.worker?.(context('multi') as never);

    expect(contribution?.jobs).toBeTypeOf('function');
    expect(contribution?.schedules).toBeTypeOf('function');
  });
});

describe('where the hosted checkout is reached from', () => {
  it('is the configured public address, as it is written', () => {
    expect(
      publicBaseUrlOf(
        config({ providers: { mpPublicBaseUrl: 'https://pagos.consultorio.test/api' } }),
      ),
    ).toBe('https://pagos.consultorio.test/api');
  });

  it('is the platform host under /api when none is configured, with the port of development', () => {
    expect(publicBaseUrlOf(config({}))).toBe('https://platform.consultorio.test/api');
    expect(
      publicBaseUrlOf(
        config({ cookieSecure: false, publicPort: 5173, platformHost: 'platform.localhost' }),
      ),
    ).toBe('http://platform.localhost:5173/api');
  });
});
