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

    const watch = jobs?.find((job) => job.name === 'fiscal.credential_watch');
    expect(watch?.category).toBe('write');
  });

  it('registers the submission to AFIP, the one job a read-only tenant still runs (for what was queued before)', () => {
    const jobs = contribution().jobs?.(workerContext);

    const issue = jobs?.find((job) => job.name === 'afip.issue');
    expect(issue?.category).toBe('afip_submission');
  });

  it('delivers an invoice as a message (cancelled in a read-only tenant) and renders its PDF only with a bucket', () => {
    const without = contribution().jobs?.(workerContext);
    const withBucket = invoicingWiring
      .worker?.({
        config: loadConfig({
          ...env,
          S3_BUCKET: 'consultorio-test',
          S3_ENDPOINT: 'http://localhost:9000',
          S3_REGION: 'us-east-1',
          S3_ACCESS_KEY_ID: 'minio',
          S3_SECRET_ACCESS_KEY: 'minio-secret',
          S3_FORCE_PATH_STYLE: 'true',
        }),
        adapters: { forTenant: () => undefined },
        email: createFakeEmailSender(),
        videoJoin: createVideoJoinRegistry(),
      })
      .jobs?.(workerContext);

    expect(without?.find((job) => job.name === 'invoice.deliver')?.category).toBe('write');
    expect(without?.map((job) => job.name).sort()).toEqual([
      'afip.issue',
      'fiscal.credential_watch',
      'invoice.deliver',
    ]);
    // A PDF is built from records a read-only organization may read: an export.
    expect(withBucket?.find((job) => job.name === 'invoice.pdf')?.category).toBe('export');
    expect(withBucket?.map((job) => job.name).sort()).toEqual([
      'afip.issue',
      'fiscal.credential_watch',
      'invoice.deliver',
      'invoice.pdf',
    ]);
  });

  it('looks at every organization certificate every six hours', () => {
    const schedules = contribution().schedules?.(workerContext);

    expect(
      schedules?.find((schedule) => schedule.name === 'fiscal.credential_watch tick'),
    ).toMatchObject({ intervalMs: 6 * 3_600_000 });
  });

  it('tries the pending invoices that are due again every thirty seconds', () => {
    const schedules = contribution().schedules?.(workerContext);

    expect(schedules?.find((schedule) => schedule.name === 'afip.issue retries')).toMatchObject({
      intervalMs: 30_000,
    });
    expect(schedules?.map((schedule) => schedule.name).sort()).toEqual([
      'afip.issue retries',
      'fiscal.credential_watch tick',
    ]);
  });

  it('needs the queue in the API, which queues each invoice with its request', () => {
    expect(invoicingWiring.needsJobs).toBe(true);
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
  it('lists the adapter that serves customers, and drives the fake of the demo organizations even without the simulator', async () => {
    const entries = invoicingWiring.devProviders?.({
      config: loadConfig({ ...env, AFIP_PROVIDER: 'off' }),
    });

    expect(entries?.map((entry) => entry.id)).toEqual(['afip']);
    // Nothing serves customers, but a demo organization still issues through the fake: its mode shows.
    expect(await entries?.[0]?.status()).toEqual({ adapter: 'off', mode: 'ok' });
    expect(entries?.[0]?.routes).toBeTypeOf('function');
  });

  it('adds the simulator controls when the simulator runs', () => {
    const entries = invoicingWiring.devProviders?.({
      config: loadConfig({ ...env, AFIP_PROVIDER: 'local' }),
    });

    expect(entries?.[0]?.routes).toBeTypeOf('function');
  });

  it('puts the fake of the demo organizations in the mode the console sets, the same one the demo issues with', async () => {
    const config = loadConfig({ ...env, AFIP_PROVIDER: 'off' });
    const issuer = invoicingWiring.adapters?.({ config, db: {} as never }).invoiceIssuer?.demo
      .adapter as { mode(): string; setMode(mode: string): void } | undefined;
    const routes: { handler: (...args: never[]) => unknown; url: string; method: string }[] = [];
    const [entry] = invoicingWiring.devProviders?.({ config }) ?? [];
    entry?.routes?.({
      withTypeProvider: () => ({
        get: (url: string, _options: unknown, handler: never) =>
          routes.push({ url, method: 'get', handler }),
        put: (url: string, _options: unknown, handler: never) =>
          routes.push({ url, method: 'put', handler }),
        post: (url: string, _options: unknown, handler: never) =>
          routes.push({ url, method: 'post', handler }),
      }),
    } as never);
    const setMode = routes.find((route) => route.url.endsWith('/mode'));

    await (setMode?.handler as (request: { body: { mode: string } }) => Promise<unknown>)({
      body: { mode: 'down' },
    });

    expect(issuer?.mode()).toBe('down');
    expect(await entry?.status()).toEqual({ adapter: 'off', mode: 'down' });
  });
});
