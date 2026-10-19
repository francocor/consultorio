import {
  ErxSimulatorStateResponse,
  type PrescriptionDto,
  type ErxSimulatorAdvanceResponse,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { erxDevRoutes } from '../../src/adapters/erx-local/dev-routes.js';
import {
  createLocalErxControls,
  createLocalPrescriptionProvider,
  type LocalErxControls,
  type LocalPrescriptionProvider,
} from '../../src/adapters/erx-local/index.js';
import { createErxJobs } from '../../src/modules/prescriptions/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import type { DevProvider } from '../../src/platform/local-providers/dev-routes.js';
import { buildTestApplication } from '../support/app.js';
import { createErxWorld, type ErxWorld } from '../support/erx-world.js';
import { runPending } from '../support/jobs.js';
import {
  createOperatorHarness,
  createTestClock,
  operatorSession,
  platformHeaders,
  type OperatorHarness,
  type TestClock,
} from '../support/operator.js';

/**
 * The e-Rx tab of the provider console (task 5.18): the controls exist only while
 * LOCAL_PROVIDERS_CONSOLE is on, only on the platform host behind the operator session, and they
 * change the same simulator the issue job talks to. A change of state is signed and posted to the
 * real webhook, so the path of a provider (signature, lookup, queued reconciliation) is the path of
 * the simulation.
 */

let runtime: DbHandle;
let harness: OperatorHarness;
let clock: TestClock;
let controls: LocalErxControls;
let provider: LocalPrescriptionProvider;
let world: ErxWorld;
let offApp: FastifyInstance;
let cookie: string;
const SECRET = 'a-secret-that-only-this-test-knows-0123456789';

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  harness = createOperatorHarness();
  clock = createTestClock();
  controls = createLocalErxControls(runtime.db);
  provider = createLocalPrescriptionProvider({ db: runtime.db, webhookSecret: SECRET });
  const devProvider: DevProvider = {
    id: 'erx',
    label: 'e-Rx',
    status: async () => ({ adapter: 'local', mode: await controls.mode() }),
    routes: erxDevRoutes({ controls, provider }),
  };
  const operator = { database: harness.db, secrets: harness.secrets };
  world = await createErxWorld(runtime, {
    slug: 'erx-console',
    served: provider,
    app: {
      operator,
      clock: clock.read,
      localProviders: { console: true, providers: [devProvider] },
    },
  });
  offApp = buildTestApplication(runtime, {
    operator,
    clock: clock.read,
    localProviders: { console: false, providers: [devProvider] },
  });
  cookie = await operatorSession(world.app, await harness.addOperator(), clock);
  await offApp.ready();
});

afterAll(async () => {
  await offApp.close();
  await world.stop();
  await harness.close();
  await runtime.close();
});

beforeEach(async () => {
  await controls.setMode('ok');
});

const send = (
  app: FastifyInstance,
  method: 'GET' | 'PUT' | 'POST',
  url: string,
  session?: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    headers: platformHeaders(session),
    remoteAddress: '10.96.3.1',
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

describe('the e-Rx controls of the provider console', () => {
  it('show the mode and the prescriptions the simulator issued, with no medication and no patient', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    const made = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();

    const response = await send(world.app, 'GET', '/operator/dev/erx/state', cookie);

    expect(response.statusCode, response.body).toBe(200);
    const state = ErxSimulatorStateResponse.parse(response.json());
    expect(state.mode).toBe('ok');
    expect(state.prescriptions[0]).toMatchObject({ externalId: made.externalId, state: 'issued' });
    expect(response.body).not.toContain('Amoxicilina');
    expect(response.body).not.toContain(patientId);
  });

  it('switch the mode of the simulator the issue reads', async () => {
    const response = await send(world.app, 'PUT', '/operator/dev/erx/mode', cookie, {
      mode: 'down',
    });
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);

    const issued = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();

    expect(response.json()).toEqual({ mode: 'down' });
    expect(await controls.mode()).toBe('down');
    expect(issued.status).toBe('pending_submission');
  });

  it('refuse a mode that does not exist', async () => {
    const response = await send(world.app, 'PUT', '/operator/dev/erx/mode', cookie, {
      mode: 'explode',
    });

    expect(response.statusCode).toBe(400);
    expect(await controls.mode()).toBe('ok');
  });

  it('move a prescription to dispensed, notify the application through its webhook, and the application ends up showing it', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    const made = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();

    const response = await send(world.app, 'POST', '/operator/dev/erx/advance', cookie, {
      externalId: made.externalId,
      to: 'dispensed',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<ErxSimulatorAdvanceResponse>()).toEqual({ delivered: true });
    expect(
      world.recorded
        .pending('erx.reconcile')
        .some((job) => job.payload['prescriptionId'] === made.id),
    ).toBe(true);
    const jobs = createErxJobs({
      adapters: { forTenant: () => provider as never },
      clock: clock.read,
      jobs: world.recorded,
      withTenant: createWithTenant(runtime.db),
      keys: world.keys,
    });
    await runPending(runtime.db, world.recorded, jobs.definitions);
    expect((await world.get(prescriber, made.id)).status).toBe('dispensed');
  });

  it('refuse to move what is not an issued prescription', async () => {
    const response = await send(world.app, 'POST', '/operator/dev/erx/advance', cookie, {
      externalId: 'NOT-A-PRESCRIPTION',
      to: 'expired',
    });

    expect(response.statusCode).toBe(404);
  });

  it('reset the prescriptions and the mode', async () => {
    await controls.setMode('timeout_after_issue');

    const response = await send(world.app, 'POST', '/operator/dev/erx/reset', cookie, {});

    expect(ErxSimulatorStateResponse.parse(response.json())).toEqual({
      mode: 'ok',
      prescriptions: [],
    });
  });

  it('need the operator session', async () => {
    expect((await send(world.app, 'GET', '/operator/dev/erx/state')).statusCode).toBe(401);
    expect(
      (await send(world.app, 'PUT', '/operator/dev/erx/mode', undefined, { mode: 'down' }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await send(world.app, 'POST', '/operator/dev/erx/advance', undefined, {
          externalId: 'x',
          to: 'expired',
        })
      ).statusCode,
    ).toBe(401);
  });

  it('do not exist while the console is off: the 404 of any unknown route', async () => {
    const state = await send(offApp, 'GET', '/operator/dev/erx/state', cookie);
    const unknown = await send(offApp, 'GET', '/operator/dev/nothing', cookie);

    expect(state.statusCode).toBe(404);
    expect({ ...state.json<object>(), requestId: 0 }).toEqual({
      ...unknown.json<object>(),
      requestId: 0,
    });
  });
});
