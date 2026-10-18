import { AfipSimulatorStateResponse } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { afipDevRoutes } from '../../src/adapters/afip-local/dev-routes.js';
import {
  createLocalAfipControls,
  createLocalInvoiceIssuer,
  type LocalAfipControls,
} from '../../src/adapters/afip-local/index.js';
import { nextCuit } from '../../src/adapters/invoice-issuer.contract.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { DevProvider } from '../../src/platform/local-providers/dev-routes.js';
import { buildTestApplication } from '../support/app.js';
import {
  createOperatorHarness,
  createTestClock,
  operatorSession,
  platformHeaders,
  type OperatorHarness,
  type TestClock,
} from '../support/operator.js';

/**
 * The AFIP tab of the provider console (task 4.42): the controls exist only while
 * LOCAL_PROVIDERS_CONSOLE is on, only on the platform host behind the operator session, and they
 * change the same simulator the issue job talks to.
 */

let runtime: DbHandle;
let harness: OperatorHarness;
let clock: TestClock;
let controls: LocalAfipControls;
let on: FastifyInstance;
let off: FastifyInstance;
let onCookie: string;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  harness = createOperatorHarness();
  clock = createTestClock();
  controls = createLocalAfipControls(runtime.db);
  const provider: DevProvider = {
    id: 'afip',
    label: 'AFIP',
    status: async () => ({ adapter: 'local', mode: await controls.mode() }),
    routes: afipDevRoutes({ controls }),
  };
  const common = {
    operator: { database: harness.db, secrets: harness.secrets },
    clock: clock.read,
  };
  on = buildTestApplication(runtime, {
    ...common,
    localProviders: { console: true, providers: [provider] },
  });
  off = buildTestApplication(runtime, {
    ...common,
    localProviders: { console: false, providers: [provider] },
  });
  onCookie = await operatorSession(on, await harness.addOperator(), clock);
  await Promise.all([on.ready(), off.ready()]);
});

afterAll(async () => {
  await on.close();
  await off.close();
  await harness.close();
  await runtime.close();
});

beforeEach(async () => {
  await controls.reset();
});

const send = (
  app: FastifyInstance,
  method: 'GET' | 'PUT' | 'POST',
  url: string,
  cookie?: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    headers: platformHeaders(cookie),
    remoteAddress: '10.96.2.1',
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

describe('the AFIP controls of the provider console', () => {
  it('show the mode and the vouchers the simulator issued', async () => {
    const cuit = nextCuit();
    await createLocalInvoiceIssuer({ db: runtime.db }).issue(
      {
        issuerCuit: cuit,
        pointOfSale: 3,
        type: 'FC',
        issueDate: '2026-10-17',
        currency: 'ARS',
        totalCents: 1_234_500,
      },
      `console-${cuit}`,
    );

    const response = await send(on, 'GET', '/operator/dev/afip/state', onCookie);

    expect(response.statusCode, response.body).toBe(200);
    const state = AfipSimulatorStateResponse.parse(response.json());
    expect(state.mode).toBe('ok');
    expect(state.vouchers[0]).toMatchObject({
      issuerCuit: cuit,
      pointOfSale: 3,
      type: 'FC',
      number: 1,
      totalCents: 1_234_500,
    });
  });

  it('switch the mode of the simulator the issuer reads', async () => {
    const response = await send(on, 'PUT', '/operator/dev/afip/mode', onCookie, { mode: 'down' });

    expect(response.json()).toEqual({ mode: 'down' });
    expect(await controls.mode()).toBe('down');
    expect(
      await createLocalInvoiceIssuer({ db: runtime.db }).issue(
        {
          issuerCuit: nextCuit(),
          pointOfSale: 1,
          type: 'FC',
          issueDate: '2026-10-17',
          currency: 'ARS',
          totalCents: 100,
        },
        'console-down',
      ),
    ).toMatchObject({ status: 'retryable' });
  });

  it('refuse a mode that does not exist', async () => {
    const response = await send(on, 'PUT', '/operator/dev/afip/mode', onCookie, {
      mode: 'explode',
    });

    expect(response.statusCode).toBe(400);
    expect(await controls.mode()).toBe('ok');
  });

  it('reset the numbering and the mode', async () => {
    const cuit = nextCuit();
    const issuer = createLocalInvoiceIssuer({ db: runtime.db });
    const request = {
      issuerCuit: cuit,
      pointOfSale: 1,
      type: 'FC',
      issueDate: '2026-10-17',
      currency: 'ARS',
      totalCents: 100,
    };
    await issuer.issue(request, `reset-a-${cuit}`);
    await controls.setMode('slow');

    const response = await send(on, 'POST', '/operator/dev/afip/reset', onCookie, {});

    expect(AfipSimulatorStateResponse.parse(response.json())).toEqual({ mode: 'ok', vouchers: [] });
    expect(await issuer.issue(request, `reset-b-${cuit}`)).toMatchObject({ number: 1 });
  });

  it('need the operator session', async () => {
    expect((await send(on, 'GET', '/operator/dev/afip/state')).statusCode).toBe(401);
    expect(
      (await send(on, 'PUT', '/operator/dev/afip/mode', undefined, { mode: 'down' })).statusCode,
    ).toBe(401);
    expect((await send(on, 'POST', '/operator/dev/afip/reset', undefined, {})).statusCode).toBe(
      401,
    );
  });

  it('do not exist while the console is off: the 404 of any unknown route', async () => {
    const state = await send(off, 'GET', '/operator/dev/afip/state', onCookie);
    const unknown = await send(off, 'GET', '/operator/dev/nothing', onCookie);

    expect(state.statusCode).toBe(404);
    expect({ ...state.json<object>(), requestId: 0 }).toEqual({
      ...unknown.json<object>(),
      requestId: 0,
    });
  });
});
