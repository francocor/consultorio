import type { PrescriptionDto, Problem } from '@consultorio/contracts';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { MODULE_WIRINGS } from '../../src/main/wiring/index.js';
import { createPrescriptionsWiring } from '../../src/main/wiring/prescriptions.js';
import type { PrescriptionDeps } from '../../src/modules/prescriptions/application/common.js';
import { settleFromProvider } from '../../src/modules/prescriptions/application/settle.js';
import { attemptSubmit } from '../../src/modules/prescriptions/application/submit.js';
import { createErxJobs } from '../../src/modules/prescriptions/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, type Tx } from '../../src/platform/db/tenant-context.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import { createErxWorld, type ErxWorld } from '../support/erx-world.js';

/**
 * JD-S5 R3, the prescriptions after the third review:
 *
 * - R3-2: no call to the provider can hang the reconciliation (`status` is bounded and the pass
 *   stops when the provider does not answer), and the pass holds no row;
 * - R3-3: the pin of a call in flight is written BEFORE the call, on the real send time, and only a
 *   definite answer clears it: a thrown error after sending, an adapter-reported unknown outcome and
 *   a crash all keep it;
 * - R3-8: a request writes its answer only while its lease is alive.
 */
let runtime: DbHandle;
let world: ErxWorld;

const TIMEOUT_MS = 300;
const PIN_MS = 10 * 60_000;
const START = new Date('2026-10-19T15:00:00Z');
const SYSTEM = '00000000-0000-0000-0000-000000000000';

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createErxWorld(runtime, {
    slug: 'prescription-round3',
    app: {
      wiring: MODULE_WIRINGS.map((wiring) =>
        wiring.name === 'prescriptions'
          ? createPrescriptionsWiring({ providerTimeoutMs: TIMEOUT_MS, inFlightPinMs: PIN_MS })
          : wiring,
      ),
    },
  });
});

afterAll(async () => {
  await world.stop();
  await runtime.close();
});

beforeEach(() => {
  world.clock.now = START;
  world.provider.reset();
});

const problemOf = (response: LightMyRequestResponse) => response.json<Problem>();

function deps(): PrescriptionDeps & { withTenant: ReturnType<typeof createWithTenant> } {
  return {
    keys: world.keys,
    adapters: { forTenant: () => world.provider as never },
    clock: () => world.clock.now,
    jobs: world.recorded,
    withTenant: createWithTenant(runtime.db),
    storage: world.storage,
    providerTimeoutMs: TIMEOUT_MS,
    inFlightPinMs: PIN_MS,
  };
}

const asJob = <T>(work: (tx: Tx) => Promise<T>) =>
  createWithTenant(runtime.db)({ tenantId: world.tenant.id, userId: SYSTEM }, work);

async function pendingAfterOutage() {
  const prescriber = await world.verifiedProfessional();
  const patientId = await world.patientWithDocument([prescriber]);
  world.provider.setMode('down');
  const pending = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
  world.provider.setMode('ok');
  expect(pending.status).toBe('pending_submission');
  return { prescriber, patientId, pending };
}

async function issued() {
  const prescriber = await world.verifiedProfessional();
  const patientId = await world.patientWithDocument([prescriber]);
  const made = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
  expect(made.status).toBe('issued');
  return { prescriber, patientId, made };
}

const never = () => new Promise<never>(() => undefined);
const settleLater = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describe('R3-2: no call of the reconciliation can hang it', () => {
  it('gives up on a status that never answers, with the signal aborted, and leaves the row as it is', async () => {
    const { made } = await issued();
    let seen: AbortSignal | undefined;
    const original = world.provider.status.bind(world.provider);
    world.provider.status = (_externalId, signal) => {
      seen = signal;
      return never();
    };
    try {
      const started = Date.now();
      const outcome = await asJob((tx) => settleFromProvider(tx, deps(), made.id));

      expect(outcome).toBe('unavailable');
      expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 10);
      expect(seen?.aborted).toBe(true);
      expect((await world.rowOf(made.id))['status']).toBe('issued');
    } finally {
      world.provider.status = original;
    }
  });

  it('stops a pass after three prescriptions in a row that the provider did not answer', async () => {
    for (let count = 0; count < 5; count += 1) await issued();
    world.clock.now = new Date(START.getTime() + 11 * 60_000);
    const original = world.provider.status.bind(world.provider);
    let asked = 0;
    world.provider.status = () => {
      asked += 1;
      return never();
    };
    const jobs = createErxJobs(deps());
    try {
      const started = Date.now();
      const result = await runJob(runtime.db, jobs.reconcile, {
        id: crypto.randomUUID(),
        name: jobs.reconcile.name,
        data: { tenantId: world.tenant.id },
        enqueuedAt: new Date(),
        retryCount: 0,
      });

      expect(result).toEqual({ status: 'completed' });
      expect(asked).toBe(3);
      expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 12);
    } finally {
      world.provider.status = original;
    }
  });

  it('does not hold the row of a prescription while it waits for the status', async () => {
    const { prescriber, made } = await issued();
    const original = world.provider.status.bind(world.provider);
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    world.provider.status = async (...args) => {
      entered();
      await settleLater(150);
      return original(...args);
    };
    try {
      const pass = asJob((tx) =>
        settleFromProvider(tx, { ...deps(), providerTimeoutMs: 5_000 }, made.id),
      );
      await inside;

      // The row is free while the provider is being asked: a cancellation does not wait for the pass.
      const started = Date.now();
      const cancelled = await world.api.post(
        `/prescriptions/${made.id}/cancel`,
        prescriber.session,
        {
          reason: 'Ya no hace falta',
        },
      );
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      expect(Date.now() - started).toBeLessThan(5_000);
      await pass;
    } finally {
      world.provider.status = original;
    }
  });
});

describe('R3-3: the pin of a call in flight', () => {
  it('is written before the call, on the time of the send', async () => {
    const { pending } = await pendingAfterOutage();
    // The question about the key takes five minutes of the clock before the request goes out.
    const asked = world.provider.findByKey.bind(world.provider);
    world.provider.findByKey = (key, signal) => {
      world.clock.now = new Date(START.getTime() + 5 * 60_000);
      return asked(key, signal);
    };
    const slow = world.provider.hold({ ignoreSignal: true });
    try {
      const attempt = asJob((tx) => attemptSubmit(tx, deps(), pending.id, { force: true }));
      await slow.entered;

      const during = await world.rowOf(pending.id);
      expect(new Date(during['provider_in_flight_until'] as string).getTime()).toBe(
        START.getTime() + 5 * 60_000 + PIN_MS,
      );
      slow.release();
      await attempt;
    } finally {
      slow.release();
      world.provider.findByKey = asked;
    }
  });

  it('keeps the pin when the call throws after the request may have left', async () => {
    const { prescriber, pending } = await pendingAfterOutage();
    const original = world.provider.issue.bind(world.provider);
    world.provider.issue = () => Promise.reject(new Error('socket hang up'));
    try {
      const first = await asJob((tx) => attemptSubmit(tx, deps(), pending.id, { force: true }));
      const second = await asJob((tx) => attemptSubmit(tx, deps(), pending.id, { force: true }));

      expect(first).toBe('retry');
      expect(second).toBe('skipped');
      expect((await world.rowOf(pending.id))['provider_in_flight_until']).not.toBeNull();

      // The professional cannot cancel it meanwhile, and is told that a send is in flight (not that
      // a request is being made "right now": it is minutes, not seconds).
      const cancel = await world.api.post(
        `/prescriptions/${pending.id}/cancel`,
        prescriber.session,
        {
          reason: 'Ya no hace falta',
        },
      );
      expect(cancel.statusCode, cancel.body).toBe(409);
      expect(problemOf(cancel).code).toBe('prescription_provider_in_flight');
    } finally {
      world.provider.issue = original;
    }
  });

  it('keeps the pin when the adapter says the outcome is unknown', async () => {
    const { pending } = await pendingAfterOutage();
    world.provider.setMode('timeout_after_issue');

    const outcome = await asJob((tx) => attemptSubmit(tx, deps(), pending.id, { force: true }));

    expect(outcome).toBe('retry');
    const row = await world.rowOf(pending.id);
    expect(new Date(row['provider_in_flight_until'] as string).getTime()).toBe(
      START.getTime() + PIN_MS,
    );
  });

  it('clears the pin on a refusal before sending (the adapter says the request never left)', async () => {
    const { pending } = await pendingAfterOutage();
    world.provider.setMode('down');

    const outcome = await asJob((tx) => attemptSubmit(tx, deps(), pending.id, { force: true }));

    expect(outcome).toBe('retry');
    expect((await world.rowOf(pending.id))['provider_in_flight_until']).toBeNull();
  });

  it('clears the pin when the provider issues, and keeps nothing after a rejection', async () => {
    const { pending } = await pendingAfterOutage();

    const outcome = await asJob((tx) => attemptSubmit(tx, deps(), pending.id, { force: true }));

    expect(outcome).toBe('issued');
    expect((await world.rowOf(pending.id))['provider_in_flight_until']).toBeNull();
  });

  it('survives a crash: the pin is committed while the call is still running', async () => {
    const { pending } = await pendingAfterOutage();
    const slow = world.provider.hold({ ignoreSignal: true });
    let attempt: Promise<unknown> | undefined;
    try {
      attempt = asJob((tx) =>
        attemptSubmit(tx, { ...deps(), providerTimeoutMs: 60_000 }, pending.id, { force: true }),
      );
      await slow.entered;

      // The process would die here: all that is left is what was committed by now.
      const row = await world.rowOf(pending.id);
      expect(new Date(row['provider_in_flight_until'] as string).getTime()).toBe(
        START.getTime() + PIN_MS,
      );
    } finally {
      slow.release();
      await attempt;
    }
  });
});

describe('R3-8: a request writes its answer only while its lease is alive', () => {
  it('does not record a cancellation answered after the lease ran out, even if nobody took the row', async () => {
    const { prescriber, made } = await issued();
    const original = world.provider.cancel.bind(world.provider);
    world.provider.cancel = (...args) => {
      // The provider is slow: the lease (two minutes) is over when it answers.
      world.clock.now = new Date(START.getTime() + 5 * 60_000);
      return original(...args);
    };
    try {
      const response = await world.api.post(
        `/prescriptions/${made.id}/cancel`,
        prescriber.session,
        {
          reason: 'Ya no hace falta',
        },
      );

      expect(response.statusCode, response.body).toBe(409);
      expect(problemOf(response).code).toBe('prescription_attempt_in_progress');
      expect((await world.rowOf(made.id))['status']).toBe('issued');
    } finally {
      world.provider.cancel = original;
    }
  });
});

describe('R3 suspect: registering by hand a prescription the provider may hold, with no provider connected', () => {
  it('waits for a provider unless the professional acknowledges it, like the cancellation', async () => {
    const { prescriber, pending } = await pendingAfterOutage();
    await world.connect(false);
    try {
      const refused = await world.api.post(
        `/prescriptions/${pending.id}/register-manual`,
        prescriber.session,
        { identifier: 'RX-SITIO-ACK-1' },
      );
      expect(refused.statusCode, refused.body).toBe(409);
      expect(problemOf(refused).code).toBe('prescription_provider_not_connected');
      expect((await world.rowOf(pending.id))['status']).toBe('pending_submission');

      const registered = await world.api.post(
        `/prescriptions/${pending.id}/register-manual`,
        prescriber.session,
        { identifier: 'RX-SITIO-ACK-1', acknowledgeUnknownOutcome: true },
      );

      expect(registered.statusCode, registered.body).toBe(200);
      const row = await world.rowOf(pending.id);
      expect(row['status']).toBe('issued');
      expect(row['registered_manually']).toBe(true);
    } finally {
      await world.connect(true);
    }
  });
});
