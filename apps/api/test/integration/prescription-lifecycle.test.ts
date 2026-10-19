import { createHmac, randomUUID } from 'node:crypto';

import type { AuditAction, PrescriptionDto, Problem } from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  createLocalErxControls,
  createLocalPrescriptionProvider,
  type LocalErxControls,
  type LocalPrescriptionProvider,
} from '../../src/adapters/erx-local/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { createErxJobs, type ErxJobs } from '../../src/modules/prescriptions/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { browserHeaders } from '../support/app.js';
import { AMOXICILLIN, createErxWorld, type ErxWorld } from '../support/erx-world.js';
import { runPending } from '../support/jobs.js';
import { asTenant } from '../support/tenants.js';

/**
 * What happens to a prescription after it is issued (e-prescription, "Issuing and status
 * lifecycle", "Immutability and cancellation", "Provider outage handling", "Read-only tenant"):
 * the provider reports it dispensed or expired, a mistaken one is cancelled through the provider
 * with a reason, a refusal leaves it issued, an issued one is never edited, and a prescription
 * issued on the site of the provider can be registered by hand.
 */

let runtime: DbHandle;
let world: ErxWorld;
let jobs: ErxJobs;
let local: LocalPrescriptionProvider;
let localControls: LocalErxControls;
let localWorld: ErxWorld;
let localJobs: ErxJobs;
const SECRET = 'a-secret-that-only-this-test-knows-0123456789';
const workerClock = { now: new Date('2026-10-19T15:00:00Z') };

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createErxWorld(runtime, { slug: 'prescription-lifecycle' });
  jobs = createErxJobs({
    adapters: { forTenant: () => world.provider as never },
    clock: () => workerClock.now,
    jobs: world.recorded,
    withTenant: createWithTenant(runtime.db),
    keys: world.keys,
    storage: world.storage,
  });
  local = createLocalPrescriptionProvider({ db: runtime.db, webhookSecret: SECRET });
  localControls = createLocalErxControls(runtime.db);
  localWorld = await createErxWorld(runtime, {
    slug: 'prescription-lifecycle-local',
    served: local,
  });
  localJobs = createErxJobs({
    adapters: { forTenant: () => local as never },
    clock: () => workerClock.now,
    jobs: localWorld.recorded,
    withTenant: createWithTenant(runtime.db),
    keys: localWorld.keys,
    storage: localWorld.storage,
  });
});

afterAll(async () => {
  await localWorld.stop();
  await world.stop();
  await runtime.close();
});

const problemOf = (response: LightMyRequestResponse) => response.json<Problem>();

async function auditsOf(w: ErxWorld, action: AuditAction, resourceId: string) {
  const rows = await asTenant(runtime, w.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, w.tenant.id), eq(auditEvent.action, action))),
  );
  return rows.filter((row) => row.resourceId === resourceId);
}

/** Queues `erx.reconcile` for the organization (or one prescription) and runs it, as the worker would. */
async function reconcile(w: ErxWorld, definitions: ErxJobs, payload: { prescriptionId?: string }) {
  w.recorded.jobs.push({
    id: randomUUID(),
    name: 'erx.reconcile',
    payload: { tenantId: w.tenant.id, ...payload },
    options: {},
    done: false,
  });
  await runPending(runtime.db, w.recorded, definitions.definitions);
}

/** A prescription issued by a new verified professional for a new patient. */
async function issued(w: ErxWorld = world) {
  const prescriber = await w.verifiedProfessional();
  const patientId = await w.patientWithDocument([prescriber]);
  const made = (await w.issue(prescriber, { patientId })).json<PrescriptionDto>();
  expect(made.status).toBe('issued');
  return { prescriber, patientId, made };
}

describe('cancelling a prescription', () => {
  it('cancels an issued prescription through the provider with a reason that stays visible', async () => {
    const { prescriber, made } = await issued();

    const response = await world.api.post(`/prescriptions/${made.id}/cancel`, prescriber.session, {
      reason: 'Error en la dosis',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PrescriptionDto>()).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Error en la dosis',
      externalId: made.externalId,
    });
    expect(
      world.provider.prescriptions().find((p) => p.externalId === made.externalId),
    ).toMatchObject({
      state: 'cancelled',
      cancelReason: 'Error en la dosis',
    });
    expect((await world.get(prescriber, made.id)).cancelReason).toBe('Error en la dosis');
  });

  it('keeps the reason out of the database in the clear and out of the audit trail, and audits the cancellation', async () => {
    const { prescriber, made } = await issued();
    await world.api.post(`/prescriptions/${made.id}/cancel`, prescriber.session, {
      reason: 'Alergia a la penicilina',
    });

    const row = await world.rowOf(made.id);
    const entries = await auditsOf(world, 'prescription.cancelled', made.id);

    expect((row['cancel_reason_enc'] as Buffer).toString('latin1')).not.toContain('penicilina');
    expect(JSON.stringify(entries)).not.toContain('penicilina');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: 'allow', patientId: made.patientId });
  });

  it('asks for a reason: without one nothing is cancelled', async () => {
    const { prescriber, made } = await issued();

    const response = await world.api.post(`/prescriptions/${made.id}/cancel`, prescriber.session, {
      reason: '   ',
    });

    expect(response.statusCode).toBe(400);
    expect((await world.get(prescriber, made.id)).status).toBe('issued');
  });

  it('leaves it issued and shows the error when the provider refuses, and audits the refusal', async () => {
    const { prescriber, made } = await issued();
    const original = world.provider.cancel.bind(world.provider);
    world.provider.cancel = () =>
      Promise.resolve({ status: 'rejected', message: 'Ya fue dispensada.' });
    try {
      const response = await world.api.post(
        `/prescriptions/${made.id}/cancel`,
        prescriber.session,
        {
          reason: 'Error en la dosis',
        },
      );

      expect(response.statusCode).toBe(409);
      expect(problemOf(response).code).toBe('prescription_cancel_refused');
    } finally {
      world.provider.cancel = original;
    }

    expect((await world.get(prescriber, made.id)).status).toBe('issued');
    expect(await auditsOf(world, 'prescription.failed', made.id)).toHaveLength(1);
  });

  it('changes nothing while the provider is down, and cancels when the same request is sent again', async () => {
    const { prescriber, made } = await issued();
    world.provider.setMode('down');
    try {
      const response = await world.api.post(
        `/prescriptions/${made.id}/cancel`,
        prescriber.session,
        {
          reason: 'Error en la dosis',
        },
      );

      expect(response.statusCode).toBe(503);
      expect(problemOf(response).code).toBe('prescription_provider_unavailable');
    } finally {
      world.provider.setMode('ok');
    }
    expect((await world.get(prescriber, made.id)).status).toBe('issued');

    const again = await world.api.post(`/prescriptions/${made.id}/cancel`, prescriber.session, {
      reason: 'Error en la dosis',
    });

    expect(again.json<PrescriptionDto>().status).toBe('cancelled');
  });

  it('refuses to cancel what is already cancelled, dispensed or expired', async () => {
    const { prescriber, made } = await issued();
    await world.api.post(`/prescriptions/${made.id}/cancel`, prescriber.session, {
      reason: 'Error',
    });

    const twice = await world.api.post(`/prescriptions/${made.id}/cancel`, prescriber.session, {
      reason: 'Otra vez',
    });

    expect(twice.statusCode).toBe(409);
    expect(problemOf(twice).code).toBe('prescription_not_cancellable');
  });

  it('lets only the prescriber cancel: a colleague who treats the patient is refused', async () => {
    const { prescriber, made, patientId } = await issued();
    const colleague = await world.verifiedProfessional();
    await world.treat(patientId, colleague);
    expect(prescriber.professionalId).not.toBe(colleague.professionalId);

    const response = await world.api.post(`/prescriptions/${made.id}/cancel`, colleague.session, {
      reason: 'No me gusta',
    });

    expect(response.statusCode).toBe(403);
    expect((await world.get(prescriber, made.id)).status).toBe('issued');
  });

  it('cancels a prescription the provider never confirmed without calling the provider', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    world.provider.setMode('down');
    const pending = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
    world.provider.setMode('ok');
    const before = world.provider.prescriptions().length;

    const response = await world.api.post(
      `/prescriptions/${pending.id}/cancel`,
      prescriber.session,
      {
        reason: 'Ya no hace falta',
      },
    );

    expect(response.json<PrescriptionDto>()).toMatchObject({
      status: 'cancelled',
      externalId: null,
      cancelReason: 'Ya no hace falta',
    });
    expect(world.provider.prescriptions().length).toBe(before);
  });

  it('does not cancel locally a prescription the provider may already have issued: it is asked first', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    world.provider.setMode('timeout_after_issue');
    const lost = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
    expect(lost.failure?.awaitingReconciliation).toBe(true);

    const response = await world.api.post(`/prescriptions/${lost.id}/cancel`, prescriber.session, {
      reason: 'Ya no hace falta',
    });

    expect(response.statusCode).toBe(409);
    expect(problemOf(response).code).toBe('prescription_awaiting_reconciliation');
  });
});

describe('an issued prescription is never edited', () => {
  it('refuses the edit, offers to cancel and issue a new one, and leaves a deny entry', async () => {
    const { prescriber, made } = await issued();

    const response = await world.api.put(`/prescriptions/${made.id}`, prescriber.session, {
      items: [{ ...AMOXICILLIN, dose: '1 g' }],
    });

    expect(response.statusCode).toBe(409);
    expect(problemOf(response).code).toBe('prescription_not_editable');
    expect((await world.get(prescriber, made.id)).items[0]?.dose).toBe('500 mg');
    const denials = await asTenant(runtime, world.tenant.id, (tx) =>
      tx.select().from(auditEvent).where(eq(auditEvent.action, 'access.denied')),
    );
    expect(
      denials.some((row) => row.resourceId === made.id && row.reason === 'prescription_immutable'),
    ).toBe(true);
  });

  it('refuses the edit of one that waits for the provider: it is what the provider is about to be sent', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    world.provider.setMode('down');
    const pending = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
    world.provider.setMode('ok');

    const response = await world.api.put(`/prescriptions/${pending.id}`, prescriber.session, {
      items: [{ ...AMOXICILLIN, dose: '1 g' }],
    });

    expect(response.statusCode).toBe(409);
    expect(problemOf(response).code).toBe('prescription_not_editable');
  });
});

describe('a prescription issued on the site of the provider', () => {
  it('is registered by hand with its identifier and flagged as such', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    world.provider.setMode('down');
    const pending = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
    world.provider.setMode('ok');

    const response = await world.api.post(
      `/prescriptions/${pending.id}/register-manual`,
      prescriber.session,
      { identifier: 'RX-SITIO-0001' },
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PrescriptionDto>()).toMatchObject({
      status: 'issued',
      externalId: 'RX-SITIO-0001',
      registeredManually: true,
      failure: null,
    });
    const entries = await auditsOf(world, 'prescription.registered_manually', pending.id);
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain('RX-SITIO-0001');
  });

  it('registers a refused draft too, and refuses an identifier that belongs to another prescription', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    const first = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
    const original = world.provider.issue.bind(world.provider);
    world.provider.issue = () => Promise.resolve({ status: 'rejected', message: 'Línea vacía' });
    let draft: PrescriptionDto;
    try {
      draft = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
    } finally {
      world.provider.issue = original;
    }
    expect(draft.status).toBe('draft');

    const taken = await world.api.post(
      `/prescriptions/${draft.id}/register-manual`,
      prescriber.session,
      {
        identifier: first.externalId,
      },
    );
    const fine = await world.api.post(
      `/prescriptions/${draft.id}/register-manual`,
      prescriber.session,
      {
        identifier: 'RX-SITIO-0002',
      },
    );

    expect(taken.statusCode).toBe(409);
    expect(problemOf(taken).code).toBe('prescription_identifier_taken');
    expect(fine.json<PrescriptionDto>()).toMatchObject({
      status: 'issued',
      registeredManually: true,
    });
  });

  it('refuses to register what the provider already confirmed', async () => {
    const { prescriber, made } = await issued();

    const response = await world.api.post(
      `/prescriptions/${made.id}/register-manual`,
      prescriber.session,
      {
        identifier: 'RX-OTRO',
      },
    );

    expect(response.statusCode).toBe(409);
    expect(problemOf(response).code).toBe('prescription_not_pending');
  });

  it('waits when the provider may have issued it already: registering by hand could make two', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    world.provider.setMode('timeout_after_issue');
    const lost = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();

    const response = await world.api.post(
      `/prescriptions/${lost.id}/register-manual`,
      prescriber.session,
      {
        identifier: 'RX-DUPLICADA',
      },
    );

    expect(response.statusCode).toBe(409);
    expect(problemOf(response).code).toBe('prescription_awaiting_reconciliation');
  });
});

describe('the status the provider reports', () => {
  it('shows a prescription as dispensed once the provider says so, found by the job that asks', async () => {
    const { prescriber, made } = await issued();
    world.provider.advance(made.externalId ?? '', 'dispensed');

    await reconcile(world, jobs, {});

    expect((await world.get(prescriber, made.id)).status).toBe('dispensed');
  });

  it('shows expired the same way, and then refuses to cancel it', async () => {
    const { prescriber, made } = await issued();
    world.provider.advance(made.externalId ?? '', 'expired');
    await reconcile(world, jobs, { prescriptionId: made.id });

    const response = await world.api.post(`/prescriptions/${made.id}/cancel`, prescriber.session, {
      reason: 'Tarde',
    });

    expect((await world.get(prescriber, made.id)).status).toBe('expired');
    expect(response.statusCode).toBe(409);
    expect(problemOf(response).code).toBe('prescription_not_cancellable');
  });

  it('follows a prescription cancelled on the side of the provider, with the reason it gave', async () => {
    const { prescriber, made } = await issued();
    await world.provider.cancel(
      made.externalId ?? '',
      'Anulada por la obra social',
      'other-channel-key',
    );
    await reconcile(world, jobs, { prescriptionId: made.id });

    const after = await world.get(prescriber, made.id);

    expect(after).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Anulada por la obra social',
    });
  });

  it('leaves a prescription registered by hand alone when the provider does not know its identifier', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    world.provider.setMode('down');
    const pending = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
    world.provider.setMode('ok');
    await world.api.post(`/prescriptions/${pending.id}/register-manual`, prescriber.session, {
      identifier: 'RX-SITIO-0003',
    });
    await reconcile(world, jobs, { prescriptionId: pending.id });

    expect((await world.get(prescriber, pending.id)).status).toBe('issued');
  });

  it('retries the prescriptions that wait for the provider when it asks about the organization', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    world.provider.setMode('down');
    const pending = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
    world.provider.setMode('ok');
    workerClock.now = new Date('2026-10-19T18:00:00Z');
    await reconcile(world, jobs, {});

    expect((await world.get(prescriber, pending.id)).status).toBe('issued');
  });

  it('settles what the provider reports in a read-only organization, but submits nothing there', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    const settled = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
    world.provider.setMode('down');
    const waiting = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
    world.provider.setMode('ok');
    world.provider.advance(settled.externalId ?? '', 'dispensed');
    const set = (status: 'active' | 'read_only') =>
      asTenant(runtime, world.tenant.id, (tx) =>
        tx
          .update(tenantTable)
          .set(
            status === 'read_only'
              ? { status, readOnlySince: new Date('2026-10-19T14:00:00Z') }
              : { status, readOnlySince: null },
          )
          .where(eq(tenantTable.id, world.tenant.id)),
      );
    await set('read_only');
    try {
      workerClock.now = new Date('2026-10-19T21:00:00Z');
      await reconcile(world, jobs, {});
      expect((await world.get(prescriber, settled.id)).status).toBe('dispensed');
      expect((await world.get(prescriber, waiting.id)).status).toBe('pending_submission');
    } finally {
      await set('active');
    }
  });
});

describe('the notice of the provider (POST /webhooks/erx)', () => {
  const body = (externalId: string) =>
    JSON.stringify({ eventId: `evt-${externalId}`, externalId, state: 'dispensed' });

  /** A notice with the headers it carries: the signature and the time it was signed. */
  const post = (raw: string, headers: Record<string, string> = {}) =>
    localWorld.app.inject({
      method: 'POST',
      url: '/webhooks/erx',
      headers: {
        'content-type': 'application/json',
        host: 'platform.consultorio.test',
        ...headers,
      },
      payload: raw,
    });
  const nowSeconds = () => String(Math.floor(Date.now() / 1000));

  it('refuses a notice without a signature, or with a wrong one, and changes nothing', async () => {
    const before = localWorld.recorded.jobs.length;
    const raw = body('ERX-NOT-SIGNED');

    const unsigned = await post(raw);
    const wrong = await post(raw, {
      'x-erx-signature': 'sha256=00',
      'x-erx-timestamp': nowSeconds(),
    });
    const tampered = await post(raw + ' ', local.signNotice(raw));

    expect([unsigned.statusCode, wrong.statusCode, tampered.statusCode]).toEqual([401, 401, 401]);
    expect(localWorld.recorded.jobs.length).toBe(before);
  });

  it('refuses a notice captured earlier: the signature covers the time and five minutes is the window (JD-S5 R1-B-T3)', async () => {
    const before = localWorld.recorded.jobs.length;
    const raw = body('ERX-REPLAYED');
    const seconds = Math.floor(Date.now() / 1000);
    const at = (offset: number) => String(seconds + offset);
    const signedAt = (offset: number) => ({
      'x-erx-signature': local.signBody(raw, at(offset)),
      'x-erx-timestamp': at(offset),
    });

    const refused = await Promise.all([
      // Signed ten minutes ago, and signed ten minutes from now.
      post(raw, signedAt(-600)),
      post(raw, signedAt(600)),
      // A signature made for another time under a fresh time.
      post(raw, { 'x-erx-signature': local.signBody(raw, at(-600)), 'x-erx-timestamp': at(0) }),
      // The scheme without a time (the HMAC of the body alone), and a notice with no time at all.
      post(raw, {
        'x-erx-signature': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`,
        'x-erx-timestamp': at(0),
      }),
      post(raw, { 'x-erx-signature': local.signNotice(raw)['x-erx-signature'] }),
      // A time that is not a whole number of seconds.
      post(raw, { 'x-erx-signature': local.signBody(raw, '1e9'), 'x-erx-timestamp': '1e9' }),
    ]);

    expect(refused.map((response) => response.statusCode)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(localWorld.recorded.jobs.length).toBe(before);
    // Within the window, in either direction, it is accepted.
    expect((await post(raw, signedAt(-240))).statusCode).toBe(200);
    expect((await post(raw, signedAt(240))).statusCode).toBe(200);
  });

  it('acknowledges a notice about an identifier nobody holds and queues nothing, telling nothing', async () => {
    const before = localWorld.recorded.jobs.length;
    const raw = body('ERX-NOBODY-HOLDS-THIS');

    const response = await post(raw, local.signNotice(raw));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: true });
    expect(localWorld.recorded.jobs.length).toBe(before);
  });

  it('queues the reconciliation of the prescription it names, and the state is whatever the provider says', async () => {
    const { prescriber, made } = await issued(localWorld);
    const externalId = made.externalId ?? '';
    await localControls.advance(externalId, 'dispensed');
    const raw = body(externalId);

    const response = await post(raw, local.signNotice(raw));
    const repeated = await post(raw, local.signNotice(raw));

    expect(response.statusCode).toBe(200);
    expect(repeated.statusCode).toBe(200);
    const queued = localWorld.recorded.pending('erx.reconcile');
    expect(queued.some((job) => job.payload['prescriptionId'] === made.id)).toBe(true);
    await runPending(runtime.db, localWorld.recorded, localJobs.definitions);
    expect((await localWorld.get(prescriber, made.id)).status).toBe('dispensed');
  });

  it('does not let a forged notice set a state: the provider is asked, and it did not dispense it', async () => {
    const { prescriber, made } = await issued(localWorld);
    const externalId = made.externalId ?? '';
    const raw = body(externalId);

    await post(raw, local.signNotice(raw));
    await runPending(runtime.db, localWorld.recorded, localJobs.definitions);

    expect((await localWorld.get(prescriber, made.id)).status).toBe('issued');
  });

  it('is accepted in a read-only organization too, and the job settles there', async () => {
    const { prescriber, made } = await issued(localWorld);
    const externalId = made.externalId ?? '';
    await localControls.advance(externalId, 'expired');
    const set = (status: 'active' | 'read_only') =>
      asTenant(runtime, localWorld.tenant.id, (tx) =>
        tx
          .update(tenantTable)
          .set(
            status === 'read_only'
              ? { status, readOnlySince: new Date('2026-10-19T14:00:00Z') }
              : { status, readOnlySince: null },
          )
          .where(eq(tenantTable.id, localWorld.tenant.id)),
      );
    await set('read_only');
    try {
      const raw = JSON.stringify({ eventId: 'evt-ro', externalId, state: 'expired' });
      const response = await post(raw, local.signNotice(raw));
      await runPending(runtime.db, localWorld.recorded, localJobs.definitions);

      expect(response.statusCode).toBe(200);
      expect((await localWorld.get(prescriber, made.id)).status).toBe('expired');
    } finally {
      await set('active');
    }
  });

  it('is not an endpoint of the browser: it answers on any host and needs no session', async () => {
    const raw = body('ERX-ANY-HOST');
    const response = await localWorld.app.inject({
      method: 'POST',
      url: '/webhooks/erx',
      headers: {
        ...browserHeaders('prescription-lifecycle-local'),
        'content-type': 'application/json',
        ...local.signNotice(raw),
      },
      payload: raw,
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('the volume of notices (JD-S5 R1-B-T3)', () => {
  it('stops a client that sends more notices than a provider ever would in a minute', async () => {
    const raw = JSON.stringify({
      eventId: 'evt-flood',
      externalId: 'ERX-FLOOD',
      state: 'dispensed',
    });
    const send = () =>
      localWorld.app.inject({
        method: 'POST',
        url: '/webhooks/erx',
        remoteAddress: '10.70.0.9',
        headers: {
          'content-type': 'application/json',
          host: 'platform.consultorio.test',
          ...local.signNotice(raw),
        },
        payload: raw,
      });

    const statuses: number[] = [];
    for (let sent = 0; sent < 260; sent += 1) statuses.push((await send()).statusCode);

    expect(statuses.slice(0, 240).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(240).every((status) => status === 429)).toBe(true);
  });
});
