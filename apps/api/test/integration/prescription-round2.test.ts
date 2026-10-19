import type { PrescriptionDto, Problem } from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { MODULE_WIRINGS } from '../../src/main/wiring/index.js';
import { createPrescriptionsWiring } from '../../src/main/wiring/prescriptions.js';
import type { PrescriptionDeps } from '../../src/modules/prescriptions/application/common.js';
import {
  attemptSubmit,
  attemptSubmitDetached,
} from '../../src/modules/prescriptions/application/submit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { createErxWorld, type ErxWorld } from '../support/erx-world.js';
import { asTenant } from '../support/tenants.js';

/**
 * JD-S5 R2, the prescriptions after the second review:
 *
 * - R2-3: a call that timed out may still be running at the provider, so the prescription is pinned
 *   for a while (no attempt even when forced, no cancellation, no manual registration);
 * - R2-6: the write-ahead mark is always status-gated, also when the row is marked already;
 * - R2-7: a lease is released only by the attempt that took it;
 * - R2-8: the gaps in the tests of the phased attempts (a live lease, a takeover, a job skipped);
 * - R2-10: a legacy row with a past attempt is asked about at the provider before a local cancel.
 */
let runtime: DbHandle;
let world: ErxWorld;
let admin: pg.Client;

/** The call to the provider is given up on after half a second; the pin is ten minutes. */
const TIMEOUT_MS = 500;
const PIN_MS = 10 * 60_000;
const START = new Date('2026-10-19T15:00:00Z');

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createErxWorld(runtime, {
    slug: 'prescription-round2',
    app: {
      wiring: MODULE_WIRINGS.map((wiring) =>
        wiring.name === 'prescriptions'
          ? createPrescriptionsWiring({ providerTimeoutMs: TIMEOUT_MS, inFlightPinMs: PIN_MS })
          : wiring,
      ),
    },
  });
  admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await world.stop();
  await runtime.close();
});

beforeEach(() => {
  world.clock.now = START;
  world.provider.reset();
});

const problemOf = (response: LightMyRequestResponse) => response.json<Problem>();

/** The services the way a long-running process builds them: a call is waited for a minute. */
function patientDeps(): PrescriptionDeps & { withTenant: ReturnType<typeof createWithTenant> } {
  return {
    keys: world.keys,
    adapters: { forTenant: () => world.provider as never },
    clock: () => world.clock.now,
    jobs: world.recorded,
    withTenant: createWithTenant(runtime.db),
    storage: world.storage,
    providerTimeoutMs: 60_000,
  };
}

/** A verified professional with a patient they treat, and a prescription the provider could not take. */
async function pendingAfterOutage() {
  const prescriber = await world.verifiedProfessional();
  const patientId = await world.patientWithDocument([prescriber]);
  world.provider.setMode('down');
  const pending = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
  world.provider.setMode('ok');
  expect(pending.status).toBe('pending_submission');
  return { prescriber, patientId, pending };
}

/** Counts the calls to `issue` (and keeps what the real one does). */
function countIssues() {
  const original = world.provider.issue.bind(world.provider);
  let calls = 0;
  let signal: AbortSignal | undefined;
  world.provider.issue = (request, key, given) => {
    calls += 1;
    signal = given;
    return original(request, key, given);
  };
  return {
    calls: () => calls,
    signal: () => signal,
    restore: () => {
      world.provider.issue = original;
    },
  };
}

const deferred = () => {
  let release!: () => void;
  let entered!: () => void;
  return {
    gate: new Promise<void>((resolve) => (release = resolve)),
    inside: new Promise<void>((resolve) => (entered = resolve)),
    release,
    entered,
  };
};

const settleLater = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describe('R2-3: a call that timed out may still be running at the provider', () => {
  it('pins the prescription: no forced retry, no cancellation, no manual registration until the pin ends', async () => {
    const { prescriber, pending } = await pendingAfterOutage();
    const slow = world.provider.hold({ ignoreSignal: true });
    const spy = countIssues();
    const before = world.provider.prescriptions().length;
    try {
      const first = await world.api.post(`/prescriptions/${pending.id}/retry`, prescriber.session);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json<PrescriptionDto>().failure).toMatchObject({
        awaitingReconciliation: true,
      });
      await slow.entered;
      expect(spy.calls()).toBe(1);
      const row = await world.rowOf(pending.id);
      expect(new Date(row['provider_in_flight_until'] as string).getTime()).toBe(
        START.getTime() + PIN_MS,
      );

      // The impatient professional presses retry again, then cancels, then registers by hand.
      const again = await world.api.post(`/prescriptions/${pending.id}/retry`, prescriber.session);
      const cancel = await world.api.post(
        `/prescriptions/${pending.id}/cancel`,
        prescriber.session,
        {
          reason: 'Ya no hace falta',
        },
      );
      const manual = await world.api.post(
        `/prescriptions/${pending.id}/register-manual`,
        prescriber.session,
        { identifier: 'RX-SITIO-4001' },
      );

      expect(again.statusCode, again.body).toBe(200);
      expect(spy.calls()).toBe(1);
      expect(cancel.statusCode, cancel.body).toBe(409);
      expect(problemOf(cancel).code).toBe('prescription_attempt_in_progress');
      expect(manual.statusCode, manual.body).toBe(409);
      expect(problemOf(manual).code).toBe('prescription_attempt_in_progress');
      expect((await world.rowOf(pending.id))['status']).toBe('pending_submission');

      // The late request reaches the provider and issues; the pin ends; the retry ADOPTS it.
      slow.release();
      await settleLater();
      expect(world.provider.prescriptions().length).toBe(before + 1);
      world.clock.now = new Date(START.getTime() + PIN_MS + 60_000);
      const adopted = await world.api.post(
        `/prescriptions/${pending.id}/retry`,
        prescriber.session,
      );
      expect(adopted.json<PrescriptionDto>().status).toBe('issued');
      expect(spy.calls()).toBe(1);
      expect(world.provider.prescriptions().length).toBe(before + 1);
    } finally {
      slow.release();
      spy.restore();
    }
  });

  it('aborts the signal it hands the provider when it stops waiting', async () => {
    const { prescriber, pending } = await pendingAfterOutage();
    let seen: AbortSignal | undefined;
    const original = world.provider.issue.bind(world.provider);
    world.provider.issue = (_request, _key, signal) => {
      seen = signal;
      return new Promise<never>(() => undefined);
    };
    try {
      const response = await world.api.post(
        `/prescriptions/${pending.id}/retry`,
        prescriber.session,
      );
      expect(response.statusCode, response.body).toBe(200);
    } finally {
      world.provider.issue = original;
    }

    expect(seen).toBeDefined();
    expect(seen?.aborted).toBe(true);
  });

  it('does not pin a call that failed fast: an outage can be retried at once', async () => {
    const { prescriber, pending } = await pendingAfterOutage();
    world.provider.setMode('down');

    const response = await world.api.post(`/prescriptions/${pending.id}/retry`, prescriber.session);

    expect(response.statusCode, response.body).toBe(200);
    expect((await world.rowOf(pending.id))['provider_in_flight_until']).toBeNull();
  });

  it('pins also the attempt of a job, and a second run of the job leaves the prescription alone', async () => {
    const { pending } = await pendingAfterOutage();
    const slow = world.provider.hold({ ignoreSignal: true });
    const spy = countIssues();
    const deps = { ...patientDeps(), providerTimeoutMs: TIMEOUT_MS, inFlightPinMs: PIN_MS };
    try {
      const asJob = (options: { force?: boolean }) =>
        createWithTenant(runtime.db)({ tenantId: world.tenant.id, userId: SYSTEM }, (tx) =>
          attemptSubmit(tx, deps, pending.id, options),
        );
      const first = await asJob({ force: true });
      const second = await asJob({ force: true });

      expect(first).toBe('retry');
      expect(second).toBe('skipped');
      expect(spy.calls()).toBe(1);
      expect((await world.rowOf(pending.id))['provider_in_flight_until']).not.toBeNull();
    } finally {
      slow.release();
      spy.restore();
    }
  });
});

describe('R2-6: the mark that comes before the call is always gated by the status', () => {
  it('sends nothing for a prescription that was already marked and left the queue meanwhile', async () => {
    const { prescriber, pending } = await pendingAfterOutage();
    // A first attempt that timed out leaves the row marked (awaiting reconciliation, contacted).
    const slow = world.provider.hold();
    const first = await world.api.post(`/prescriptions/${pending.id}/retry`, prescriber.session);
    expect(first.statusCode, first.body).toBe(200);
    // The provider never takes this one: the call stays held for good.
    const marked = await world.rowOf(pending.id);
    expect(marked['delivery_state']).toBe('awaiting_reconciliation');
    expect(marked['provider_contacted_at']).not.toBeNull();
    world.clock.now = new Date(START.getTime() + PIN_MS + 60_000);

    // While the provider is asked about the key, somebody closes the row.
    const asked = world.provider.findByKey.bind(world.provider);
    world.provider.findByKey = async (key, signal) => {
      await closeBehindTheirBack(pending.id);
      return asked(key, signal);
    };
    const spy = countIssues();
    try {
      const retried = await world.api.post(
        `/prescriptions/${pending.id}/retry`,
        prescriber.session,
      );

      expect(retried.statusCode, retried.body).toBe(200);
      expect(retried.json<PrescriptionDto>().status).toBe('draft');
      expect(spy.calls()).toBe(0);
    } finally {
      slow.release();
      world.provider.findByKey = asked;
      spy.restore();
    }
  });
});

describe('R2-7 and R2-8: a lease belongs to the attempt that took it', () => {
  it('leaves the lease of the attempt that took over when the one that overran lets go', async () => {
    const { pending } = await pendingAfterOutage();
    const deps = patientDeps();
    const [a, b] = [deferred(), deferred()];
    const original = world.provider.issue.bind(world.provider);
    let calls = 0;
    world.provider.issue = async (request, key, signal) => {
      calls += 1;
      const mine = calls === 1 ? a : b;
      mine.entered();
      await mine.gate;
      return original(request, key, signal);
    };
    try {
      const first = attemptSubmitDetached(deps, world.tenant.id, pending.id, { force: true });
      await a.inside;
      const leaseOfA = (await world.rowOf(pending.id))['attempt_lease_token'];
      expect(leaseOfA).not.toBeNull();

      // A overruns: its lease runs out, and another attempt takes the row over.
      world.clock.now = new Date(START.getTime() + 5 * 60_000);
      const second = attemptSubmitDetached(deps, world.tenant.id, pending.id, { force: true });
      await b.inside;
      const leaseOfB = (await world.rowOf(pending.id))['attempt_lease_token'];
      expect(leaseOfB).not.toBeNull();
      expect(leaseOfB).not.toBe(leaseOfA);

      // A finishes first: it lets go of ITS lease, not of the one of B.
      a.release();
      expect(await first).toBe('issued');
      const during = await world.rowOf(pending.id);
      expect(during['attempt_lease_token']).toBe(leaseOfB);
      expect(during['attempt_lease_until']).not.toBeNull();

      b.release();
      // B finds the prescription issued already (same identifier): nothing is orphaned.
      expect(await second).toBe('skipped');
      const after = await world.rowOf(pending.id);
      expect(after['attempt_lease_token']).toBeNull();
      expect(after['attempt_lease_until']).toBeNull();
      expect(world.provider.prescriptions().filter((p) => p.state === 'issued')).toHaveLength(1);
      const orphans = await asTenant(runtime, world.tenant.id, (tx) =>
        tx
          .select()
          .from(auditEvent)
          .where(
            and(
              eq(auditEvent.action, 'prescription.failed'),
              eq(auditEvent.resourceId, pending.id),
            ),
          ),
      );
      expect(orphans.some((entry) => entry.reason === 'orphaned')).toBe(false);
    } finally {
      a.release();
      b.release();
      world.provider.issue = original;
    }
  });

  it('respects a live lease: another attempt, forced or not, sends nothing; an expired one is taken over', async () => {
    const { pending } = await pendingAfterOutage();
    const deps = patientDeps();
    const slow = deferred();
    const original = world.provider.issue.bind(world.provider);
    let calls = 0;
    world.provider.issue = async (request, key, signal) => {
      calls += 1;
      slow.entered();
      await slow.gate;
      return original(request, key, signal);
    };
    try {
      const running = attemptSubmitDetached(deps, world.tenant.id, pending.id, { force: true });
      await slow.inside;

      // A job (it holds a transaction) and a forced request find the lease and leave the row alone.
      const asJob = await createWithTenant(runtime.db)(
        { tenantId: world.tenant.id, userId: SYSTEM },
        (tx) => attemptSubmit(tx, deps, pending.id, { force: true }),
      );
      const forced = await attemptSubmitDetached(deps, world.tenant.id, pending.id, {
        force: true,
      });
      expect(asJob).toBe('skipped');
      expect(forced).toBe('skipped');
      expect(calls).toBe(1);

      // Two minutes later the lease has run out: the next attempt takes the row.
      world.clock.now = new Date(START.getTime() + 3 * 60_000);
      const takeover = attemptSubmitDetached(deps, world.tenant.id, pending.id, { force: true });
      await settleLater(100);
      expect(calls).toBe(2);
      slow.release();
      await Promise.all([running, takeover]);
      expect((await world.rowOf(pending.id))['status']).toBe('issued');
      expect(world.provider.prescriptions().filter((p) => p.state === 'issued')).toHaveLength(1);
    } finally {
      slow.release();
      world.provider.issue = original;
    }
  });
});

describe('R2-10: a legacy row with a past attempt is asked about at the provider', () => {
  it('does not cancel locally a prescription the provider holds when only last_attempt_at tells it was sent', async () => {
    const { prescriber, pending } = await pendingAfterOutage();
    const key = (await world.rowOf(pending.id))['idempotency_key'] as string;
    // The provider took it (the answer was lost) and the row predates the marks of JD-S5 R1.
    await world.provider.issue(
      {
        matricula: { jurisdiction: 'AR-B', number: 'MP 12345' },
        patientDocument: { type: 'dni', number: '30123456' },
        items: ['Amoxicilina 500 mg, comprimidos, 1 cada 8 horas durante 7 dias, 21 comprimidos'],
      },
      key,
    );
    await admin.query('BEGIN');
    try {
      await admin.query(`set local session_replication_role = replica`);
      await admin.query(
        `update prescription set provider_contacted_at = null, delivery_state = 'retrying',
                last_attempt_at = now() where id = $1`,
        [pending.id],
      );
    } finally {
      await admin.query('COMMIT');
    }

    const cancelled = await world.api.post(
      `/prescriptions/${pending.id}/cancel`,
      prescriber.session,
      {
        reason: 'Ya no hace falta',
      },
    );

    expect(cancelled.statusCode, cancelled.body).toBe(409);
    expect(problemOf(cancelled).code).toBe('prescription_awaiting_reconciliation');
    expect((await world.rowOf(pending.id))['status']).toBe('pending_submission');
  });
});

const SYSTEM = '00000000-0000-0000-0000-000000000000';

/** Takes a prescription out of the queue as a second process would, behind the back of an attempt. */
async function closeBehindTheirBack(id: string): Promise<void> {
  // One round trip: the provider is only waited for a moment in these tests.
  await admin.query(
    `BEGIN;
     select set_config('app.tenant_id', '${world.tenant.id}', true);
     select set_config('app.user_id', '${SYSTEM}', true);
     update prescription set status = 'draft', rejection_message = 'closed elsewhere',
            delivery_state = null where id = '${id}';
     COMMIT;`,
  );
}
