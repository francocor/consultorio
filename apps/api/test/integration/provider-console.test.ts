import { DevProvidersResponse } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { DevProvider } from '../../src/platform/local-providers/dev-routes.js';
import { browserHeaders, buildTestApplication } from '../support/app.js';
import {
  createOperatorHarness,
  createTestClock,
  operatorSession,
  platformHeaders,
  type OperatorHarness,
  type TestClock,
} from '../support/operator.js';

let runtime: DbHandle;
let harness: OperatorHarness;
let clock: TestClock;
let off: FastifyInstance;
let on: FastifyInstance;
let offCookie: string;
let onCookie: string;

const providers: DevProvider[] = [
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    status: () => Promise.resolve({ adapter: 'local', mode: 'ok' }),
    routes: (app) => {
      app.get(
        '/operator/dev/whatsapp/messages',
        { config: { readOnly: 'read', auth: 'public', operatorAuth: 'session' } },
        () => ({ messages: ['one'] }),
      );
    },
  },
  {
    id: 'video',
    label: 'Video',
    status: () => Promise.resolve({ adapter: 'off', mode: null }),
  },
];

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  harness = createOperatorHarness();
  clock = createTestClock();
  const common = {
    operator: { database: harness.db, secrets: harness.secrets },
    clock: clock.read,
  };
  off = buildTestApplication(runtime, {
    ...common,
    localProviders: { console: false, providers },
  });
  on = buildTestApplication(runtime, { ...common, localProviders: { console: true, providers } });
  offCookie = await operatorSession(off, await harness.addOperator(), clock);
  onCookie = await operatorSession(on, await harness.addOperator(), clock);
  await Promise.all([off.ready(), on.ready()]);
});

afterAll(async () => {
  await off.close();
  await on.close();
  await harness.close();
  await runtime.close();
});

/** The body of a problem answer without the request id, which is different every time. */
const shape = (response: { json: () => unknown }) => ({
  ...(response.json() as Record<string, unknown>),
  requestId: undefined,
});

const platform = (app: FastifyInstance, url: string, cookie?: string) =>
  app.inject({ method: 'GET', url, headers: platformHeaders(cookie), remoteAddress: '10.96.1.1' });

describe('with LOCAL_PROVIDERS_CONSOLE off', () => {
  it('has no /operator/dev route: a signed-in operator gets the 404 of an unknown route', async () => {
    const providersList = await platform(off, '/operator/dev/providers', offCookie);
    const own = await platform(off, '/operator/dev/whatsapp/messages', offCookie);
    const unknown = await platform(off, '/operator/dev/nothing', offCookie);

    for (const response of [providersList, own]) {
      expect(response.statusCode).toBe(404);
      expect(shape(response)).toEqual(shape(unknown));
    }
  });
});

describe('with LOCAL_PROVIDERS_CONSOLE on', () => {
  it('lists the active adapter and the mode of each provider to a signed-in operator', async () => {
    const response = await platform(on, '/operator/dev/providers', onCookie);

    expect(response.statusCode, response.body).toBe(200);
    expect(DevProvidersResponse.parse(response.json())).toEqual({
      providers: [
        { id: 'whatsapp', label: 'WhatsApp', adapter: 'local', mode: 'ok' },
        { id: 'video', label: 'Video', adapter: 'off', mode: null },
      ],
    });
  });

  it('is behind the operator session: no cookie is a 401 and so is a stale one', async () => {
    expect((await platform(on, '/operator/dev/providers')).statusCode).toBe(401);
    expect((await platform(on, '/operator/dev/providers', '__Host-osid=stale')).statusCode).toBe(
      401,
    );
  });

  it('gives the routes a provider adds the same protection', async () => {
    expect((await platform(on, '/operator/dev/whatsapp/messages')).statusCode).toBe(401);
    const signedIn = await platform(on, '/operator/dev/whatsapp/messages', onCookie);

    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json()).toEqual({ messages: ['one'] });
  });

  it('answers a non-operator, on a tenant host, exactly like an unknown route', async () => {
    const tenantHost = await on.inject({
      method: 'GET',
      url: '/operator/dev/providers',
      headers: browserHeaders('any-clinic'),
    });
    const unknown = await on.inject({
      method: 'GET',
      url: '/operator/dev/never-existed',
      headers: browserHeaders('any-clinic'),
    });

    expect(tenantHost.statusCode).toBe(404);
    expect(shape(tenantHost)).toEqual(shape(unknown));
  });
});
