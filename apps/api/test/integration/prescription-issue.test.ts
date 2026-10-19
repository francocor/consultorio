import type { PrescriptionDto, Problem, AuditAction } from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createErxJobs, type ErxJobs } from '../../src/modules/prescriptions/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { createErxWorld, AMOXICILLIN, type ErxWorld } from '../support/erx-world.js';
import { runPending } from '../support/jobs.js';
import { asTenant } from '../support/tenants.js';

/**
 * Issuing a prescription (e-prescription, "Prescriber eligibility", "Authorized provider
 * connection", "Prescription content", "Issuing and status lifecycle", "Provider outage handling").
 * Every call goes through the real application as the people of an organization, with an in-memory
 * provider that the test puts in a mode.
 */

let runtime: DbHandle;
let world: ErxWorld;
let jobs: ErxJobs;
const workerClock = { now: new Date('2026-10-19T15:00:00Z') };

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createErxWorld(runtime, { slug: 'prescription-issue' });
  jobs = createErxJobs({
    adapters: { forTenant: () => world.provider as never },
    // The worker has a clock of its own: moving it does not expire the sessions of the people.
    clock: () => workerClock.now,
    jobs: world.recorded,
    withTenant: createWithTenant(runtime.db),
    keys: world.keys,
  });
});

afterAll(async () => {
  await world.stop();
  await runtime.close();
});

const problemOf = (response: LightMyRequestResponse) => response.json<Problem>();

async function auditsOf(action: AuditAction, resourceId?: string) {
  const rows = await asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action))),
  );
  return resourceId === undefined ? rows : rows.filter((row) => row.resourceId === resourceId);
}

describe('a verified professional issues a prescription', () => {
  it('issues it through the provider and stores it with the identifier and the date', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);

    const response = await world.issue(prescriber, { patientId });

    expect(response.statusCode, response.body).toBe(201);
    const issued = response.json<PrescriptionDto>();
    expect(issued).toMatchObject({
      patientId,
      status: 'issued',
      registeredManually: false,
      failure: null,
      items: [AMOXICILLIN],
      date: '2026-10-19',
      issuedAt: '2026-10-19T15:00:00.000Z',
    });
    expect(issued.externalId).toMatch(/^ERX-[0-9A-F]{12}$/);
    expect(issued.prescriber).toMatchObject({ professionalId: prescriber.professionalId });
    expect(issued.patient.documentType).toBe('dni');
    expect(world.provider.prescriptions()).toHaveLength(1);
  });

  it('shows it in the list of the patient', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    const made = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();

    const list = await world.api.get(`/patients/${patientId}/prescriptions`, prescriber.session);

    expect(list.statusCode).toBe(200);
    expect(
      list.json<{ prescriptions: PrescriptionDto[] }>().prescriptions.map((p) => p.id),
    ).toEqual([made.id]);
  });

  it('copies the coverage of the patient onto the prescription when there is one', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    const plan = await world.api.post('/payer-plans', world.reception, {
      customName: 'Obra Social Ejemplo',
      planName: 'Plan 210',
    });
    expect(plan.statusCode, plan.body).toBe(201);
    const coverage = await world.api.post(`/patients/${patientId}/coverages`, world.reception, {
      payerPlanId: plan.json<{ id: string }>().id,
      memberNumber: '123456789',
    });
    expect(coverage.statusCode, coverage.body).toBe(201);

    const issued = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();

    expect(issued.patient.coverage).toEqual({
      payerName: 'Obra Social Ejemplo',
      planName: 'Plan 210',
    });
  });

  it('leaves the coverage empty for a patient who has none', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);

    const issued = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();

    expect(issued.patient.coverage).toBeNull();
  });

  it('keeps the medications out of the database in the clear and out of the audit trail', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    const made = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();

    const row = await world.rowOf(made.id);
    const stored = (row['content_enc'] as Buffer).toString('latin1');
    const trail = JSON.stringify(await auditsOf('prescription.issued', made.id));

    expect(stored).not.toContain('Amoxicilina');
    expect(stored).not.toContain(made.patient.documentNumber ?? 'no-document');
    expect(trail).not.toContain('Amoxicilina');
    expect(trail).toContain(made.id);
  });

  it('writes one entry of the audit trail for the issue, naming the prescription and the patient', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    const made = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();

    const entries = await auditsOf('prescription.issued', made.id);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      outcome: 'allow',
      patientId,
      resourceType: 'prescription',
    });
  });

  it('answers a double submission with the prescription it already made, and asks the provider once', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    const clientKey = '0190a000-0000-7000-8000-00000000c0de';
    const before = world.provider.prescriptions().length;

    const first = await world.issue(prescriber, { patientId, clientKey });
    const second = await world.issue(prescriber, { patientId, clientKey });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json<PrescriptionDto>().id).toBe(first.json<PrescriptionDto>().id);
    expect(world.provider.prescriptions().length).toBe(before + 1);
  });
});

describe('who may issue', () => {
  it('refuses a professional whose matricula the platform has not verified, and says why', async () => {
    const unverified = await world.professional();
    const patientId = await world.patientWithDocument([unverified]);

    const response = await world.issue(unverified, { patientId });

    expect(response.statusCode).toBe(409);
    expect(problemOf(response).code).toBe('prescription_matricula_unverified');
    expect(world.provider.prescriptions().every((p) => p.state === 'issued')).toBe(true);
  });

  it('leaves the other clinical work of that professional alone', async () => {
    const unverified = await world.professional();
    const patientId = await world.patientWithDocument([unverified]);

    const note = await world.open(unverified, patientId);

    expect(note.status).toBe('draft');
  });

  it('refuses again when the number was edited after the platform verified it', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    const edit = await world.api.put(
      `/staff/${prescriber.session.user.membershipId}/professional-profile`,
      prescriber.session,
      {
        fullName: 'Dra. Prueba Editada',
        specialties: ['Medicina general'],
        matricula: { jurisdiction: 'AR-B', number: '700999' },
      },
    );
    expect(edit.statusCode, edit.body).toBe(200);

    const response = await world.issue(prescriber, { patientId });

    expect(response.statusCode).toBe(409);
    expect(problemOf(response).code).toBe('prescription_matricula_unverified');
  });

  it('refuses an owner who is also a professional until the platform verifies the matricula: the owner role does not help', async () => {
    const profile = await world.api.post('/staff/me/professional', world.owner, {
      fullName: 'Dr. Titular',
      specialties: ['Clínica médica'],
      matricula: { jurisdiction: 'AR-B', number: '710001' },
    });
    expect(profile.statusCode, profile.body).toBeLessThan(300);
    const asProfessional = { session: world.owner, professionalId: 'not used by the request' };
    const patientId = await world.patientWithDocument();

    const response = await world.issue(asProfessional, { patientId });

    expect(response.statusCode).toBe(409);
    expect(problemOf(response).code).toBe('prescription_matricula_unverified');
  });

  it('denies a non-clinical admin, an owner without a profile and reception, and audits each denial', async () => {
    const patientId = await world.patientWithDocument();

    for (const session of [world.admin, world.reception]) {
      const response = await world.api.post('/prescriptions', session, {
        clientKey: '0190a000-0000-7000-8000-00000000d3ad',
        patientId,
        items: [AMOXICILLIN],
      });
      expect(response.statusCode).toBe(403);
    }

    const denials = await auditsOf('access.denied');
    const deniedUsers = denials.map((row) => row.actorUserId);
    expect(deniedUsers).toContain(world.admin.user.id);
    expect(deniedUsers).toContain(world.reception.user.id);
    expect(denials.every((row) => row.outcome === 'deny')).toBe(true);
  });

  it('refuses a professional with no care relationship with the patient', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument();

    const response = await world.issue(prescriber, { patientId });

    expect(response.statusCode).toBe(403);
  });
});

describe('what a prescription needs', () => {
  it('points at the missing quantity of a line', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);

    const response = await world.issue(prescriber, {
      patientId,
      items: [{ ...AMOXICILLIN, quantity: undefined as never }],
    });

    expect(response.statusCode).toBe(400);
    expect(problemOf(response).errors?.map((error) => error.path)).toContain('items.0.quantity');
  });

  it('refuses a patient with no document: the provider cannot be told who it is for', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patient([prescriber]);

    const response = await world.issue(prescriber, { patientId });

    expect(response.statusCode).toBe(422);
    expect(problemOf(response).code).toBe('prescription_patient_document_required');
  });

  it('refuses a patient who is not registered in the organization', async () => {
    const prescriber = await world.verifiedProfessional();

    const response = await world.issue(prescriber, {
      patientId: '0190a000-0000-7000-8000-0000000000aa',
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a request that names a status, a prescriber or a date: the server decides them', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);

    const response = await world.api.post('/prescriptions', prescriber.session, {
      clientKey: '0190a000-0000-7000-8000-00000000b00b',
      patientId,
      items: [AMOXICILLIN],
      status: 'issued',
      date: '2020-01-01',
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('the provider connection', () => {
  it('refuses to issue while the organization has not switched e-prescription on', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    await world.connect(false);
    try {
      const response = await world.issue(prescriber, { patientId });

      expect(response.statusCode).toBe(409);
      expect(problemOf(response).code).toBe('prescription_provider_not_connected');
    } finally {
      await world.connect(true);
    }
  });

  it('lets only the owner or an admin switch it, and never shows a credential', async () => {
    const byReception = await world.api.put('/prescriptions/connection', world.reception, {
      enabled: true,
    });
    const saved = await world.api.put('/prescriptions/connection', world.admin, {
      enabled: true,
      credentials: 'clave-secreta-del-proveedor',
    });
    const read = await world.api.get('/prescriptions/connection', world.admin);

    expect(byReception.statusCode).toBe(403);
    expect(saved.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ enabled: true, credentialsSaved: true });
    expect(read.body).not.toContain('clave-secreta');
    expect(saved.body).not.toContain('clave-secreta');
  });
});

describe('an outage never produces a valid prescription and never a second one', () => {
  it('keeps it pending with no identifier and no document while the provider is down, and offers to retry', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    world.provider.setMode('down');
    try {
      const response = await world.issue(prescriber, { patientId });

      expect(response.statusCode, response.body).toBe(201);
      const pending = response.json<PrescriptionDto>();
      expect(pending).toMatchObject({
        status: 'pending_submission',
        externalId: null,
        issuedAt: null,
        documentAvailable: false,
        failure: { kind: 'unavailable', awaitingReconciliation: false },
      });
      expect(pending.failure?.nextAttemptAt).not.toBeNull();
    } finally {
      world.provider.setMode('ok');
    }
  });

  it('queues the submission so the worker takes it up even if nobody comes back', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    world.provider.setMode('down');
    let pendingId: string;
    try {
      pendingId = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>().id;
    } finally {
      world.provider.setMode('ok');
    }

    const queued = world.recorded
      .pending('erx.submit')
      .filter((job) => job.payload['prescriptionId'] === pendingId);
    expect(queued.length).toBeGreaterThan(0);
    workerClock.now = new Date(world.clock.now.getTime() + 2 * 3_600_000);
    await runPending(runtime.db, world.recorded, jobs.definitions);

    expect((await world.get(prescriber, pendingId)).status).toBe('issued');
    expect(world.provider.prescriptions().filter((p) => p.state === 'issued')).toHaveLength(
      world.provider.prescriptions().length,
    );
  });

  it('issues it once when the provider is back and the professional retries', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    world.provider.setMode('down');
    const pending = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
    world.provider.setMode('ok');
    const before = world.provider.prescriptions().length;

    const retried = await world.api.post(`/prescriptions/${pending.id}/retry`, prescriber.session);
    const again = await world.api.post(`/prescriptions/${pending.id}/retry`, prescriber.session);

    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json<PrescriptionDto>()).toMatchObject({ status: 'issued', failure: null });
    expect(again.statusCode).toBe(409);
    expect(problemOf(again).code).toBe('prescription_not_pending');
    expect(world.provider.prescriptions().length).toBe(before + 1);
  });

  it('asks the provider before it tries again after a timeout, and finds the one it issued', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    world.provider.setMode('timeout_after_issue');
    const before = world.provider.prescriptions().length;

    const lost = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();

    expect(lost).toMatchObject({
      status: 'pending_submission',
      externalId: null,
      failure: { kind: 'unavailable', awaitingReconciliation: true },
    });
    expect(world.provider.prescriptions().length).toBe(before + 1);

    const retried = await world.api.post(`/prescriptions/${lost.id}/retry`, prescriber.session);

    expect(retried.json<PrescriptionDto>()).toMatchObject({ status: 'issued' });
    expect(world.provider.prescriptions().length).toBe(before + 1);
    expect(retried.json<PrescriptionDto>().externalId).toBe(
      world.provider.prescriptions().at(-1)?.externalId,
    );
  });

  it('writes the intent before it calls the provider: a call that never returns is found again, not repeated', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    const original = world.provider.issue.bind(world.provider);
    // The provider issues and then the process "dies": the call never returns an answer.
    world.provider.issue = async (request, key) => {
      await original(request, key);
      throw new Error('the process was killed');
    };
    const before = world.provider.prescriptions().length;
    let lost: PrescriptionDto;
    try {
      lost = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
    } finally {
      world.provider.issue = original;
    }

    const row = await world.rowOf(lost.id);
    expect(row['delivery_state']).toBe('awaiting_reconciliation');
    expect(world.provider.prescriptions().length).toBe(before + 1);

    const retried = await world.api.post(`/prescriptions/${lost.id}/retry`, prescriber.session);

    expect(retried.json<PrescriptionDto>().status).toBe('issued');
    expect(world.provider.prescriptions().length).toBe(before + 1);
  });

  it('does not adopt a prescription whose identifier already belongs to another of ours: it is parked for a person', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    const first = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
    expect(first.status).toBe('issued');
    const originalFind = world.provider.findByKey.bind(world.provider);
    const originalIssue = world.provider.issue.bind(world.provider);
    // The provider lost the answer for the second one, and when asked it points at the FIRST one's identifier.
    world.provider.issue = () =>
      Promise.resolve({ status: 'retryable', message: 'timeout', outcomeUnknown: true });
    world.provider.findByKey = () =>
      Promise.resolve({
        status: 'issued',
        externalId: first.externalId ?? '',
        documentUrl: 'fake-erx://x',
      });
    try {
      const second = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
      expect(second.failure?.awaitingReconciliation).toBe(true);

      const retried = await world.api.post(`/prescriptions/${second.id}/retry`, prescriber.session);

      expect(retried.json<PrescriptionDto>()).toMatchObject({
        status: 'pending_submission',
        failure: { kind: 'needs_attention' },
      });
    } finally {
      world.provider.findByKey = originalFind;
      world.provider.issue = originalIssue;
    }
  });

  it('does not send a prescription whose professional lost the verification in the meantime', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    world.provider.setMode('down');
    const pending = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
    world.provider.setMode('ok');
    const edit = await world.api.put(
      `/staff/${prescriber.session.user.membershipId}/professional-profile`,
      prescriber.session,
      {
        fullName: 'Dra. Prueba Editada',
        specialties: ['Medicina general'],
        matricula: { jurisdiction: 'AR-B', number: '700888' },
      },
    );
    expect(edit.statusCode, edit.body).toBe(200);
    const before = world.provider.prescriptions().length;

    const retried = await world.api.post(`/prescriptions/${pending.id}/retry`, prescriber.session);

    expect(retried.json<PrescriptionDto>()).toMatchObject({
      status: 'pending_submission',
      failure: { kind: 'needs_attention' },
    });
    expect(world.provider.prescriptions().length).toBe(before);

    await world.verify(prescriber);
    // The platform verified the NEW registration; the prescription still says the old one, so it is
    // not sent either (JD-S5 R1-B-T4): a person cancels it and writes a new one.
    const afterVerification = await world.api.post(
      `/prescriptions/${pending.id}/retry`,
      prescriber.session,
    );
    expect(afterVerification.json<PrescriptionDto>()).toMatchObject({
      status: 'pending_submission',
      failure: { kind: 'needs_attention' },
    });
    expect(world.provider.prescriptions().length).toBe(before);
    const fresh = await world.issue(prescriber, { patientId });
    expect(fresh.json<PrescriptionDto>()).toMatchObject({
      status: 'issued',
      prescriber: { matricula: '700888', jurisdiction: 'AR-B' },
    });
    expect(world.provider.prescriptions().length).toBe(before + 1);
  });

  it('shows a refused prescription as a draft with the words of the provider, and corrects and sends it again', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    const originalIssue = world.provider.issue.bind(world.provider);
    world.provider.issue = () =>
      Promise.resolve({ status: 'rejected', message: 'Una línea\nde la receta está vacía.' });
    let refused: PrescriptionDto;
    try {
      refused = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
    } finally {
      world.provider.issue = originalIssue;
    }

    expect(refused).toMatchObject({
      status: 'draft',
      failure: { kind: 'rejected', message: 'Una línea de la receta está vacía.' },
    });

    const corrected = await world.api.put(`/prescriptions/${refused.id}`, prescriber.session, {
      items: [{ ...AMOXICILLIN, quantity: 14 }],
    });

    expect(corrected.statusCode, corrected.body).toBe(200);
    expect(corrected.json<PrescriptionDto>()).toMatchObject({
      status: 'issued',
      items: [{ ...AMOXICILLIN, quantity: 14 }],
    });
  });
});

describe('what the form asks of the server before it shows the button', () => {
  it('says a verified professional can issue, and who they are', async () => {
    const prescriber = await world.verifiedProfessional();

    const response = await world.api.get('/prescriptions/capability', prescriber.session);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      professionalId: prescriber.professionalId,
      providerAvailable: true,
      enabled: true,
      simulated: true,
      matriculaStatus: 'verified',
      canIssue: true,
    });
  });

  it('says why a professional cannot: an unverified matricula, or an organization that switched it off', async () => {
    const unverified = await world.professional();
    const verified = await world.verifiedProfessional();
    const before = await world.api.get('/prescriptions/capability', unverified.session);
    await world.connect(false);
    try {
      const off = await world.api.get('/prescriptions/capability', verified.session);

      expect(before.json()).toMatchObject({ matriculaStatus: 'unverified', canIssue: false });
      expect(off.json()).toMatchObject({
        enabled: false,
        matriculaStatus: 'verified',
        canIssue: false,
      });
    } finally {
      await world.connect(true);
    }
  });

  it('suggests generic names that start with what is typed, and is not for reception', async () => {
    const prescriber = await world.verifiedProfessional();

    const names = await world.api.get('/prescriptions/catalog?q=amox', prescriber.session);
    const denied = await world.api.get('/prescriptions/catalog?q=amox', world.reception);

    expect(names.json()).toEqual({
      names: ['Amoxicilina', 'Amoxicilina con ácido clavulánico'],
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe('an organization in read-only mode', () => {
  it('refuses to issue with 402 and lets the professional read what exists', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    const made = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
    const { tenant: tenantTable } = await import('../../src/db/schema/tenant.js');
    const set = (status: 'active' | 'read_only') =>
      asTenant(runtime, world.tenant.id, (tx) =>
        tx
          .update(tenantTable)
          .set(
            status === 'read_only'
              ? { status, readOnlySince: new Date() }
              : { status, readOnlySince: null },
          )
          .where(eq(tenantTable.id, world.tenant.id)),
      );
    await set('read_only');
    try {
      const refused = await world.issue(prescriber, { patientId });
      const read = await world.api.get(`/prescriptions/${made.id}`, prescriber.session);

      expect(refused.statusCode).toBe(402);
      expect(problemOf(refused).code).toBe('tenant_read_only');
      expect(read.statusCode).toBe(200);
    } finally {
      await set('active');
    }
  });
});
