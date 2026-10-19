import { randomUUID } from 'node:crypto';

import type { PrescriptionDto, Problem } from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { KEY_REUSED_MESSAGE } from '../../src/adapters/erx-fake/prescription-rules.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { createErxJobs, type ErxJobs } from '../../src/modules/prescriptions/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { AMOXICILLIN, createErxWorld, type ErxWorld } from '../support/erx-world.js';
import { runPending } from '../support/jobs.js';
import { asTenant } from '../support/tenants.js';

/**
 * JD-S5 R1, the prescriptions: an attempt never races a cancellation or a manual registration
 * (S5-3), a corrected prescription is sent under a key of its own after a real refusal (S5-4), the
 * prescription says the registration the platform verified (B-T4), a provider that does not answer
 * cannot hang an attempt (B-T10), and the manual registration is gated (A-T5).
 */
let runtime: DbHandle;
let world: ErxWorld;
let admin: pg.Client;
let timedJobs: ErxJobs;
const workerClock = { now: new Date('2026-10-19T15:00:00Z') };

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createErxWorld(runtime, { slug: 'prescription-hardening' });
  admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  timedJobs = createErxJobs({
    adapters: { forTenant: () => world.provider as never },
    clock: () => workerClock.now,
    jobs: world.recorded,
    withTenant: createWithTenant(runtime.db),
    keys: world.keys,
    storage: world.storage,
    // A provider that does not answer is given up on after fifty milliseconds, not twenty seconds.
    providerTimeoutMs: 50,
  });
});

afterAll(async () => {
  await admin.end();
  await world.stop();
  await runtime.close();
});

const problemOf = (response: LightMyRequestResponse) => response.json<Problem>();

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

/** The matricula stops being verified, the way the operator console does it. */
async function unverify(professionalId: string): Promise<void> {
  await admin.query('BEGIN');
  try {
    await admin.query('SET LOCAL ROLE app_operator');
    await admin.query(`select set_config('app.tenant_id', $1, true)`, [world.tenant.id]);
    await admin.query(
      `update professional set matricula_status = 'unverified', verified_by_operator = null, verified_at = null where id = $1`,
      [professionalId],
    );
  } finally {
    await admin.query('COMMIT');
  }
}

/**
 * Takes a prescription out of the queue as a second process would, behind the back of an attempt
 * that is running: it is no longer waiting for the provider (a refused draft, as a correction flow
 * would leave it).
 */
async function closeBehindTheirBack(id: string): Promise<void> {
  await admin.query('BEGIN');
  try {
    await admin.query(`select set_config('app.tenant_id', $1, true)`, [world.tenant.id]);
    await admin.query(
      `select set_config('app.user_id', '00000000-0000-0000-0000-000000000000', true)`,
    );
    await admin.query(
      `update prescription set status = 'draft', rejection_message = 'closed elsewhere',
              delivery_state = null where id = $1`,
      [id],
    );
  } finally {
    await admin.query('COMMIT');
  }
}

describe('S5-3: a cancellation or a manual registration never races an attempt', () => {
  it('sends nothing for a prescription that left the queue while the provider was being asked', async () => {
    const { prescriber, pending } = await pendingAfterOutage();
    const asked = world.provider.findByKey.bind(world.provider);
    const issue = world.provider.issue.bind(world.provider);
    let issued = 0;
    world.provider.issue = (request, key) => {
      issued += 1;
      return issue(request, key);
    };
    world.provider.findByKey = async (key) => {
      await closeBehindTheirBack(pending.id);
      return asked(key);
    };
    const before = world.provider.prescriptions().length;
    try {
      const retried = await world.api.post(
        `/prescriptions/${pending.id}/retry`,
        prescriber.session,
      );

      expect(retried.statusCode, retried.body).toBe(200);
      expect(retried.json<PrescriptionDto>().status).toBe('draft');
    } finally {
      world.provider.findByKey = asked;
      world.provider.issue = issue;
    }

    expect(issued).toBe(0);
    expect(world.provider.prescriptions().length).toBe(before);
  });

  it('asks the provider before cancelling a prescription that was parked after an unknown outcome', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    world.provider.setMode('timeout_after_issue');
    const lost = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
    world.provider.setMode('ok');
    expect(lost.failure?.awaitingReconciliation).toBe(true);
    const held = world.provider.prescriptions().length;
    // The registration is withdrawn: the next attempt PARKS the prescription, which overwrites the
    // "awaiting reconciliation" state, although the provider still holds the prescription.
    await unverify(prescriber.professionalId);
    const parked = (
      await world.api.post(`/prescriptions/${lost.id}/retry`, prescriber.session)
    ).json<PrescriptionDto>();
    expect(parked.failure).toMatchObject({
      kind: 'needs_attention',
      awaitingReconciliation: false,
    });
    const row = await world.rowOf(lost.id);
    expect(row['delivery_state']).toBe('needs_attention');
    expect(row['provider_contacted_at']).not.toBeNull();

    const cancelled = await world.api.post(`/prescriptions/${lost.id}/cancel`, prescriber.session, {
      reason: 'Ya no hace falta',
    });

    expect(cancelled.statusCode, cancelled.body).toBe(409);
    expect(problemOf(cancelled).code).toBe('prescription_awaiting_reconciliation');
    expect((await world.rowOf(lost.id))['status']).toBe('pending_submission');
    // Nor can it be registered by hand: the provider holds it.
    await world.verify(prescriber);
    const manual = await world.api.post(
      `/prescriptions/${lost.id}/register-manual`,
      prescriber.session,
      {
        identifier: 'RX-SITIO-HOLDS',
      },
    );
    expect(manual.statusCode).toBe(409);
    expect(problemOf(manual).code).toBe('prescription_awaiting_reconciliation');
    // Retrying adopts what the provider holds, and nothing is issued twice.
    const adopted = await world.api.post(`/prescriptions/${lost.id}/retry`, prescriber.session);
    expect(adopted.json<PrescriptionDto>().status).toBe('issued');
    expect(world.provider.prescriptions().length).toBe(held);
  });

  it('cancels locally a parked prescription the provider does not hold', async () => {
    const { prescriber, pending } = await pendingAfterOutage();
    await unverify(prescriber.professionalId);
    await world.api.post(`/prescriptions/${pending.id}/retry`, prescriber.session);

    const cancelled = await world.api.post(
      `/prescriptions/${pending.id}/cancel`,
      prescriber.session,
      {
        reason: 'Ya no hace falta',
      },
    );

    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json<PrescriptionDto>().status).toBe('cancelled');
  });

  it('refuses to cancel or to register by hand while an attempt is waiting for the provider', async () => {
    const { prescriber, pending } = await pendingAfterOutage();
    let leave!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (leave = resolve));
    const asked = world.provider.findByKey.bind(world.provider);
    world.provider.findByKey = async (key) => {
      entered();
      await gate;
      return asked(key);
    };
    try {
      const attempt = world.api.post(`/prescriptions/${pending.id}/retry`, prescriber.session);
      await inside;

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
        { identifier: 'RX-SITIO-9001' },
      );
      leave();
      const done = await attempt;

      expect(cancel.statusCode, cancel.body).toBe(409);
      expect(problemOf(cancel).code).toBe('prescription_attempt_in_progress');
      expect(manual.statusCode, manual.body).toBe(409);
      expect(problemOf(manual).code).toBe('prescription_attempt_in_progress');
      expect(done.json<PrescriptionDto>().status).toBe('issued');
    } finally {
      leave();
      world.provider.findByKey = asked;
    }
  });
});

describe('S5-4: a corrected prescription is sent under a key of its own', () => {
  /** A provider that remembers a refusal under its key and answers "key already used" to another request. */
  function refusingOnce() {
    const original = world.provider.issue.bind(world.provider);
    const refused = new Map<string, string>();
    let refuseNext = true;
    world.provider.issue = (request, key) => {
      const fingerprint = JSON.stringify(request.items);
      const known = refused.get(key);
      if (known !== undefined) {
        return Promise.resolve({
          status: 'rejected',
          message: known === fingerprint ? 'Línea vacía' : KEY_REUSED_MESSAGE,
        });
      }
      if (refuseNext) {
        refuseNext = false;
        refused.set(key, fingerprint);
        return Promise.resolve({ status: 'rejected', message: 'Línea vacía' });
      }
      return original(request, key);
    };
    return () => {
      world.provider.issue = original;
    };
  }

  it('issues the corrected prescription after a real refusal, with the next version of the key', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    const restore = refusingOnce();
    try {
      const refused = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
      expect(refused.status).toBe('draft');
      const firstKey = (await world.rowOf(refused.id))['idempotency_key'];
      const before = world.provider.prescriptions().length;

      const corrected = await world.api.put(`/prescriptions/${refused.id}`, prescriber.session, {
        items: [{ ...AMOXICILLIN, quantity: 14 }],
      });

      expect(corrected.statusCode, corrected.body).toBe(200);
      expect(corrected.json<PrescriptionDto>()).toMatchObject({
        status: 'issued',
        items: [{ ...AMOXICILLIN, quantity: 14 }],
      });
      const row = await world.rowOf(refused.id);
      expect(row['submission_version']).toBe(2);
      expect(row['idempotency_key']).not.toBe(firstKey);
      expect(world.provider.prescriptions().length).toBe(before + 1);
    } finally {
      restore();
    }
  });
});

describe('B-T4: the prescription says the registration the platform verified', () => {
  it('parks a prescription whose professional changed the registration, even once it is verified again', async () => {
    const { prescriber, pending } = await pendingAfterOutage();
    const edit = await world.api.put(
      `/staff/${prescriber.session.user.membershipId}/professional-profile`,
      prescriber.session,
      {
        fullName: 'Dra. Prueba Editada',
        specialties: ['Medicina general'],
        matricula: { jurisdiction: 'AR-B', number: '710999' },
      },
    );
    expect(edit.statusCode, edit.body).toBe(200);
    await world.verify(prescriber);
    const before = world.provider.prescriptions().length;

    const retried = await world.api.post(`/prescriptions/${pending.id}/retry`, prescriber.session);

    expect(retried.json<PrescriptionDto>()).toMatchObject({
      status: 'pending_submission',
      failure: { kind: 'needs_attention' },
    });
    expect(world.provider.prescriptions().length).toBe(before);
    const failures = await asTenant(runtime, world.tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(
          and(eq(auditEvent.action, 'prescription.failed'), eq(auditEvent.resourceId, pending.id)),
        ),
    );
    expect(failures.some((entry) => entry.reason === 'matricula_changed')).toBe(true);
  });
});

describe('B-T10: a provider that does not answer cannot hang an attempt', () => {
  it('counts the outcome as unknown and asks the provider for the key before it sends again', async () => {
    const { pending, patientId } = await pendingAfterOutage();
    expect(patientId).toBeTruthy();
    for (const job of world.recorded.jobs) {
      if (job.payload['prescriptionId'] !== pending.id) job.done = true;
    }
    const issue = world.provider.issue.bind(world.provider);
    world.provider.issue = () => new Promise<never>(() => undefined);
    workerClock.now = new Date('2026-10-19T20:00:00Z');
    const started = Date.now();
    try {
      await runPending(runtime.db, world.recorded, timedJobs.definitions);
    } finally {
      world.provider.issue = issue;
    }

    expect(Date.now() - started).toBeLessThan(10_000);
    const row = await world.rowOf(pending.id);
    expect(row['status']).toBe('pending_submission');
    expect(row['delivery_state']).toBe('awaiting_reconciliation');
    expect(row['provider_contacted_at']).not.toBeNull();
  });
});

describe('A-T5: the manual registration is gated', () => {
  it('refuses an identifier that is not one: spaces, symbols, too short', async () => {
    const { prescriber, pending } = await pendingAfterOutage();

    const responses = await Promise.all(
      ['a b c d', 'RX;DROP', 'ab', '<script>x</script>'].map((identifier) =>
        world.api.post(`/prescriptions/${pending.id}/register-manual`, prescriber.session, {
          identifier,
        }),
      ),
    );

    for (const response of responses) expect(response.statusCode, response.body).toBe(400);
    expect((await world.get(prescriber, pending.id)).status).toBe('pending_submission');
  });

  it('checks the registration again: a withdrawn one cannot vouch for a typed identifier', async () => {
    const { prescriber, pending } = await pendingAfterOutage();
    await unverify(prescriber.professionalId);

    const response = await world.api.post(
      `/prescriptions/${pending.id}/register-manual`,
      prescriber.session,
      { identifier: 'RX-SITIO-7001' },
    );

    expect(response.statusCode, response.body).toBe(409);
    expect(problemOf(response).code).toBe('prescription_matricula_unverified');
    expect((await world.get(prescriber, pending.id)).status).toBe('pending_submission');
  });
});

describe('B-S3: a list is one read in the trail', () => {
  it('writes one entry for the list of a patient, with how many it showed', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    for (let n = 0; n < 3; n += 1) {
      const made = await world.issue(prescriber, { patientId, clientKey: randomUUID() });
      expect(made.statusCode, made.body).toBe(201);
    }
    const countBefore = async () =>
      (
        await asTenant(runtime, world.tenant.id, (tx) =>
          tx
            .select()
            .from(auditEvent)
            .where(
              and(eq(auditEvent.action, 'prescription.read'), eq(auditEvent.patientId, patientId)),
            ),
        )
      ).length;
    const before = await countBefore();

    const listed = await world.api.get(`/patients/${patientId}/prescriptions`, prescriber.session);

    expect(listed.statusCode, listed.body).toBe(200);
    expect(await countBefore()).toBe(before + 1);
    const entries = await asTenant(runtime, world.tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(
          and(eq(auditEvent.action, 'prescription.read'), eq(auditEvent.patientId, patientId)),
        ),
    );
    expect(entries.at(-1)?.metadata).toMatchObject({ via: 'list', count: 3 });
  });
});
