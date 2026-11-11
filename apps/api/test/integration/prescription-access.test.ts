import type {
  AuditAction,
  DownloadLinkResponse,
  PrescriptionDto,
  PrescriptionExistenceResponse,
  PrescriptionListResponse,
  Problem,
} from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { registerPrescriptionsExportContributors } from '../../src/modules/prescriptions/index.js';
import { createExportRegistry } from '../../src/modules/tenancy/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { AMOXICILLIN, createErxWorld, type ErxWorld } from '../support/erx-world.js';
import { settled } from '../support/export-sections.js';
import { readPdf } from '../support/pdf.js';
import { asTenant } from '../support/tenants.js';

/**
 * Who reads a prescription, what they see, and what is written down (e-prescription, "Clinical
 * access rules", "Audit, retention and tenant isolation", "Patient access and delivery"; design
 * D17). Every call goes through the real application as the people of an organization.
 */

let runtime: DbHandle;
let world: ErxWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createErxWorld(runtime, { slug: 'prescription-access' });
});

afterAll(async () => {
  await world.stop();
  await runtime.close();
});

const problemOf = (response: LightMyRequestResponse) => response.json<Problem>();

const setSettings = (settings: Record<string, unknown>) =>
  asTenant(runtime, world.tenant.id, (tx) =>
    tx.update(tenantTable).set({ settings }).where(eq(tenantTable.id, world.tenant.id)),
  );

async function auditsOf(action: AuditAction, resourceId?: string) {
  const rows = await asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action))),
  );
  return resourceId === undefined ? rows : rows.filter((row) => row.resourceId === resourceId);
}

/** A prescription issued by a new verified professional for a new patient they treat. */
async function issued() {
  const prescriber = await world.verifiedProfessional();
  const patientId = await world.patientWithDocument([prescriber]);
  const made = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
  expect(made.status).toBe('issued');
  return { prescriber, patientId, made };
}

describe('the prescriber and the professionals who treat the patient read it', () => {
  it('lets the prescriber read it and writes one entry of the trail with the actor, the patient and the prescription', async () => {
    const { prescriber, patientId, made } = await issued();

    const response = await world.api.get(`/prescriptions/${made.id}`, prescriber.session);

    expect(response.statusCode).toBe(200);
    expect(response.json<PrescriptionDto>().items).toEqual([AMOXICILLIN]);
    const entries = await auditsOf('prescription.read', made.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      outcome: 'allow',
      actorUserId: prescriber.session.user.id,
      patientId,
      resourceType: 'prescription',
    });
    expect(JSON.stringify(entries)).not.toContain('Amoxicilina');
  });

  it('lets a professional who treats the patient read it although the sharing scope is off', async () => {
    const { made, patientId } = await issued();
    const colleague = await world.verifiedProfessional();
    await world.treat(patientId, colleague);

    const response = await world.api.get(`/prescriptions/${made.id}`, colleague.session);
    const list = await world.api.get(`/patients/${patientId}/prescriptions`, colleague.session);

    expect(response.statusCode, response.body).toBe(200);
    expect(list.json<PrescriptionListResponse>().prescriptions.map((p) => p.id)).toContain(made.id);
  });

  it('lists the prescriptions of the prescriber, and only theirs', async () => {
    const { prescriber, made } = await issued();
    const other = await issued();

    const mine = await world.api.get('/prescriptions', prescriber.session);

    const ids = mine.json<PrescriptionListResponse>().prescriptions.map((p) => p.id);
    expect(ids).toContain(made.id);
    expect(ids).not.toContain(other.made.id);
  });
});

describe('nobody else reads it (decision D17)', () => {
  it('denies a professional with no care relationship, with the sharing scope off, and audits the denial', async () => {
    const { made, patientId } = await issued();
    const stranger = await world.verifiedProfessional();

    const response = await world.api.get(`/prescriptions/${made.id}`, stranger.session);
    const list = await world.api.get(`/patients/${patientId}/prescriptions`, stranger.session);

    expect(response.statusCode).toBe(403);
    expect(list.json<PrescriptionListResponse>().prescriptions).toEqual([]);
    const denials = await asTenant(runtime, world.tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.action, 'access.denied'), eq(auditEvent.resourceId, made.id))),
    );
    expect(denials.map((row) => [row.actorUserId, row.outcome, row.patientId])).toContainEqual([
      stranger.session.user.id,
      'deny',
      patientId,
    ]);
  });

  it('denies that professional too with the sharing scope ON and every template shared: a prescription never follows sharing', async () => {
    const { made } = await issued();
    const stranger = await world.verifiedProfessional();
    await setSettings({ clinicalSharing: true, sharedTemplates: ['general', 'prescription'] });
    try {
      const response = await world.api.get(`/prescriptions/${made.id}`, stranger.session);
      const link = await world.api.post(
        `/prescriptions/${made.id}/document-link`,
        stranger.session,
      );

      expect(response.statusCode).toBe(403);
      expect(link.statusCode).toBe(403);
    } finally {
      await setSettings({});
    }
    const denials = await asTenant(runtime, world.tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.action, 'access.denied'), eq(auditEvent.resourceId, made.id))),
    );
    expect(
      denials.filter((row) => row.actorUserId === stranger.session.user.id).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('answers a prescription that does not exist as "not found", not as a denial', async () => {
    const stranger = await world.verifiedProfessional();

    const response = await world.api.get(
      '/prescriptions/0190a000-0000-7000-8000-0000000000aa',
      stranger.session,
    );

    expect(response.statusCode).toBe(404);
  });

  it('denies an owner, an admin and reception every prescription route, and audits each denial', async () => {
    const { made, patientId } = await issued();
    const routes: [string, string][] = [
      ['GET', `/prescriptions/${made.id}`],
      ['GET', `/patients/${patientId}/prescriptions`],
      ['GET', '/prescriptions'],
      ['GET', '/prescriptions/capability'],
      ['POST', `/prescriptions/${made.id}/document-link`],
    ];

    for (const session of [world.owner, world.admin, world.reception]) {
      for (const [method, url] of routes) {
        const response =
          method === 'GET'
            ? await world.api.get(url, session)
            : await world.api.post(url, session, {});
        expect(response.statusCode, `${method} ${url}`).toBe(403);
      }
    }

    const denied = (await auditsOf('access.denied')).map((row) => row.actorUserId);
    for (const session of [world.owner, world.admin, world.reception]) {
      expect(denied).toContain(session.user.id);
    }
  });
});

describe('reception', () => {
  it('sees nothing of the prescriptions while the organization has not allowed it', async () => {
    const { patientId } = await issued();
    await setSettings({});

    const response = await world.api.get(
      `/patients/${patientId}/prescriptions/existence`,
      world.reception,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json<PrescriptionExistenceResponse>()).toEqual({
      visible: false,
      prescriptions: [],
    });
  });

  it('sees that a prescription exists, when it was made and where it stands, once the organization allows it, and never its content', async () => {
    const { patientId, made } = await issued();
    await setSettings({ reception_sees_clinical_metadata: true });
    try {
      const response = await world.api.get(
        `/patients/${patientId}/prescriptions/existence`,
        world.reception,
      );

      expect(response.statusCode).toBe(200);
      const body = response.json<PrescriptionExistenceResponse>();
      expect(body.visible).toBe(true);
      expect(body.prescriptions.map((p) => [p.id, p.status])).toEqual([[made.id, 'issued']]);
      expect(response.body).not.toContain('Amoxicilina');
      expect(response.body).not.toContain(made.externalId ?? 'no-id');
    } finally {
      await setSettings({});
    }
  });

  it('is refused the content even with the setting on', async () => {
    const { patientId, made } = await issued();
    await setSettings({ reception_sees_clinical_metadata: true });
    try {
      const one = await world.api.get(`/prescriptions/${made.id}`, world.reception);
      const list = await world.api.get(`/patients/${patientId}/prescriptions`, world.reception);

      expect(one.statusCode).toBe(403);
      expect(list.statusCode).toBe(403);
    } finally {
      await setSettings({});
    }
  });

  it('never gives the existence to a non-clinical admin or owner, whatever the setting, and audits the attempt', async () => {
    const { patientId } = await issued();
    await setSettings({ reception_sees_clinical_metadata: true });
    try {
      for (const session of [world.admin, world.owner]) {
        const response = await world.api.get(
          `/patients/${patientId}/prescriptions/existence`,
          session,
        );
        expect(response.statusCode).toBe(403);
      }
    } finally {
      await setSettings({});
    }
    const denied = (await auditsOf('access.denied')).map((row) => row.actorUserId);
    expect(denied).toContain(world.admin.user.id);
    expect(denied).toContain(world.owner.user.id);
  });
});

describe('the document of a prescription', () => {
  it('is a PDF that names the prescription and says it is simulated, opened with a link that works once, in the session that asked', async () => {
    const { prescriber, made } = await issued();
    const linkResponse = await world.api.post(
      `/prescriptions/${made.id}/document-link`,
      prescriber.session,
    );
    expect(linkResponse.statusCode, linkResponse.body).toBe(200);
    const link = linkResponse.json<DownloadLinkResponse>();

    const download = await world.api.get(link.url, prescriber.session);
    const again = await world.api.get(link.url, prescriber.session);

    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/pdf');
    expect(download.headers['content-disposition']).toMatch(
      /^attachment; filename="receta-2026-10-19-[0-9a-f]{8}\.pdf"$/,
    );
    const text = readPdf(download.rawPayload).texts.join(' ');
    expect(text).toContain('Amoxicilina');
    expect(text).toContain(made.externalId ?? 'no-id');
    expect(text).toContain('Receta electrónica simulada, sin validez legal');
    expect(again.statusCode).toBe(403);
    const entries = await auditsOf('prescription.downloaded', made.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorUserId: prescriber.session.user.id });
  });

  it('is refused to another session: the link is bound to the one that asked for it', async () => {
    const { prescriber, made } = await issued();
    const colleague = await world.verifiedProfessional();
    const link = (
      await world.api.post(`/prescriptions/${made.id}/document-link`, prescriber.session)
    ).json<DownloadLinkResponse>();

    const stolen = await world.api.get(link.url, colleague.session);

    expect(stolen.statusCode).toBe(403);
  });

  it('is not offered for a prescription the provider has not confirmed, nor for a cancelled one', async () => {
    const prescriber = await world.verifiedProfessional();
    const patientId = await world.patientWithDocument([prescriber]);
    world.provider.setMode('down');
    const pending = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
    world.provider.setMode('ok');
    const { made, prescriber: other } = await issued();
    await world.api.post(`/prescriptions/${made.id}/cancel`, other.session, { reason: 'Error' });

    const waiting = await world.api.post(
      `/prescriptions/${pending.id}/document-link`,
      prescriber.session,
    );
    const cancelled = await world.api.post(
      `/prescriptions/${made.id}/document-link`,
      other.session,
    );

    expect(waiting.statusCode).toBe(409);
    expect(problemOf(waiting).code).toBe('prescription_document_not_ready');
    expect(cancelled.statusCode).toBe(409);
    expect(
      world.storage.keys().filter((key) => key.includes('/prescriptions/')).length,
    ).toBeGreaterThan(0);
  });

  it('lets a professional who treats the patient download it, and stops a link when the access is lost in the minutes since', async () => {
    const { made, patientId } = await issued();
    const colleague = await world.verifiedProfessional();
    await world.treat(patientId, colleague);
    const link = (
      await world.api.post(`/prescriptions/${made.id}/document-link`, colleague.session)
    ).json<DownloadLinkResponse>();
    expect(link.url).toMatch(/^\/files\//);

    const removed = await world.api.delete(
      `/patients/${patientId}/assignments/${colleague.professionalId}`,
      world.owner,
    );
    const download = await world.api.get(link.url, colleague.session);

    // The assignment was the colleague's only way in: when it goes, the link goes with it.
    expect(removed.statusCode).toBeLessThan(300);
    expect(download.statusCode).toBe(403);
  });
});

describe('the cancellation export', () => {
  it("gives each professional the prescriptions they can read, decrypted, with their state, and nobody else's", async () => {
    const { prescriber, made } = await issued();
    const stranger = await issued();
    await world.api.post(`/prescriptions/${stranger.made.id}/cancel`, stranger.prescriber.session, {
      reason: 'Error en la dosis',
    });
    const registry = createExportRegistry();
    registerPrescriptionsExportContributors(registry, { keys: world.keys });
    const [contributor] = registry.list();
    if (!contributor) throw new Error('the prescriptions contributor is not registered');

    const part = await createWithTenant(runtime.db)(
      {
        tenantId: world.tenant.id,
        userId: prescriber.session.user.id,
        actingProfessionalId: prescriber.professionalId,
      },
      (tx) =>
        settled(
          contributor.contribute({
            tx,
            tenantId: world.tenant.id,
            professionalId: prescriber.professionalId,
          }),
        ),
    );

    const exported = (part as { prescriptions: Record<string, unknown>[] }).prescriptions;
    expect(exported.map((p) => p['id'])).toEqual(expect.arrayContaining([made.id]));
    expect(exported.map((p) => p['id'])).not.toContain(stranger.made.id);
    const mine = exported.find((p) => p['id'] === made.id);
    expect(mine).toMatchObject({
      status: 'issued',
      externalId: made.externalId,
      items: [AMOXICILLIN],
    });

    const theirs = await createWithTenant(runtime.db)(
      {
        tenantId: world.tenant.id,
        userId: stranger.prescriber.session.user.id,
        actingProfessionalId: stranger.prescriber.professionalId,
      },
      (tx) =>
        settled(
          contributor.contribute({
            tx,
            tenantId: world.tenant.id,
            professionalId: stranger.prescriber.professionalId,
          }),
        ),
    );
    const cancelled = (theirs as { prescriptions: Record<string, unknown>[] }).prescriptions.find(
      (p) => p['id'] === stranger.made.id,
    );
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Error en la dosis' });
  });
});
