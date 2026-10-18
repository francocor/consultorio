import { describe, expect, it } from 'vitest';

import { createFakeEmailSender } from '../../adapters/fake-email/index.js';
import { createVideoJoinRegistry } from '../../modules/notifications/index.js';
import { loadConfig } from '../config.js';

import { invoicingWiring } from './invoicing.js';

const env = {
  DATABASE_URL: 'postgres://app_rw:placeholder@localhost:5432/app',
  BASE_DOMAIN: 'consultorio.test',
  PLATFORM_HOST: 'platform.consultorio.test',
  KMS_LOCAL_KEK_BASE64: Buffer.alloc(32, 7).toString('base64'),
};

function contribution() {
  const worker = invoicingWiring.worker;
  if (!worker) throw new Error('invoicing adds nothing to the worker');
  return worker({
    config: loadConfig(env),
    adapters: { forTenant: () => undefined },
    email: createFakeEmailSender(),
    videoJoin: createVideoJoinRegistry(),
  });
}

const workerContext = {
  client: {} as never,
  db: {} as never,
  metrics: {} as never,
  log: {} as never,
};

describe('what invoicing adds to the worker', () => {
  it('registers the credential watch on its queue, as a job that a read-only tenant does not run', () => {
    const jobs = contribution().jobs?.(workerContext);

    expect(jobs?.map((job) => job.name)).toEqual(['fiscal.credential_watch']);
    expect(jobs?.[0]?.category).toBe('write');
  });

  it('looks at every organization certificate every six hours', () => {
    const schedules = contribution().schedules?.(workerContext);

    expect(schedules).toHaveLength(1);
    expect(schedules?.[0]).toMatchObject({
      name: 'fiscal.credential_watch tick',
      intervalMs: 6 * 3_600_000,
    });
  });
});

describe('the invoice issuer slot of invoicing', () => {
  const slot = (overrides: Record<string, string> = {}) => {
    const adapters = invoicingWiring.adapters;
    if (!adapters) throw new Error('invoicing registers an adapter');
    return adapters({ config: loadConfig({ ...env, ...overrides }), db: {} as never })
      .invoiceIssuer;
  };

  it('serves customers with the local simulator while AFIP_PROVIDER=local, marked as a fake', () => {
    const registered = slot({ AFIP_PROVIDER: 'local' });

    expect(registered?.real).toMatchObject({ kind: 'fake' });
    expect(registered?.real?.adapter).toMatchObject({ simulated: true });
  });

  it('serves customers with nothing while the real adapter does not exist (afip) or invoicing is off', () => {
    expect(slot({ AFIP_PROVIDER: 'afip', NODE_ENV: 'development' })?.real).toBeUndefined();
    expect(slot({ AFIP_PROVIDER: 'off' })?.real).toBeUndefined();
  });

  it('always serves demo organizations with the in-memory fake', () => {
    for (const provider of ['local', 'off', 'afip']) {
      expect(slot({ AFIP_PROVIDER: provider })?.demo).toMatchObject({ kind: 'fake' });
    }
  });
});

describe('the AFIP entry of the provider console', () => {
  it('lists the adapter that serves customers and has no controls without the simulator', async () => {
    const entries = invoicingWiring.devProviders?.({
      config: loadConfig({ ...env, AFIP_PROVIDER: 'off' }),
    });

    expect(entries?.map((entry) => entry.id)).toEqual(['afip']);
    expect(await entries?.[0]?.status()).toEqual({ adapter: 'off', mode: null });
    expect(entries?.[0]?.routes).toBeUndefined();
  });

  it('adds the simulator controls when the simulator runs', () => {
    const entries = invoicingWiring.devProviders?.({
      config: loadConfig({ ...env, AFIP_PROVIDER: 'local' }),
    });

    expect(entries?.[0]?.routes).toBeTypeOf('function');
  });
});
