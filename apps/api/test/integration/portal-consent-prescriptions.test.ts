import { randomUUID } from 'node:crypto';

import type {
  ConsentTemplateDetailResponse,
  ConsentTemplateDto,
  CreateConsentRequestResponse,
  PortalConsentDetailDto,
  PortalConsentResponse,
  PortalConsentsResponse,
  PortalDownloadLinkResponse,
  PortalPrescriptionsResponse,
  PrescriptionDto,
} from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFakePrescriptionProvider } from '../../src/adapters/erx-fake/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { careAssignment } from '../../src/db/schema/care.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';
import { AMOXICILLIN } from '../support/erx-world.js';
import { createPortalWorld, type PortalWorld } from '../support/portal-world.js';

/**
 * The patient portal over the REAL consent and prescriptions modules, wired the way `main` wires
 * them (no fake port): a portal patient lists and signs a consent, lists a prescription and
 * downloads it. The only thing replaced is the e-prescription provider, with the in-memory fake.
 */
let runtime: DbHandle;
let world: PortalWorld;
let admin: pg.Client;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createPortalWorld(runtime, {
    slug: 'portal-real-path',
    erx: createFakePrescriptionProvider(),
  });
  admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  // The owner switches e-prescription on and the operator verifies the matricula of the prescriber.
  const connected = await world.api.put('/prescriptions/connection', world.owner, {
    enabled: true,
  });
  expect(connected.statusCode, connected.body).toBe(200);
  await admin.query('BEGIN');
  try {
    await admin.query('SET LOCAL ROLE app_operator');
    await admin.query(`select set_config('app.tenant_id', $1, true)`, [world.tenant.id]);
    await admin.query(
      `update professional set matricula_status = 'verified', verified_by_operator = $1, verified_at = now() where id = $2`,
      [uuidv7(), world.doctor.professionalId],
    );
  } finally {
    await admin.query('COMMIT');
  }
});

afterAll(async () => {
  await admin.end();
  await world.close();
  await runtime.close();
});

const auditsOf = (action: string, resourceId: string) =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, action as never), eq(auditEvent.resourceId, resourceId))),
  );

/** A patient with a portal account whom the doctor treats. */
async function portalPatient() {
  const session = await world.patientSession();
  await world.inTenant((tx) =>
    tx.insert(careAssignment).values({
      tenantId: world.tenant.id,
      patientId: session.patientId,
      professionalId: world.doctor.professionalId,
      assignedBy: randomUUID(),
    }),
  );
  return session;
}

describe('a consent, through the portal and the consent module', () => {
  it('is listed, read, signed and downloaded by the patient it was requested from', async () => {
    const { visitor, patientId } = await portalPatient();
    const created = await world.api.post('/consent/templates', world.admin, {
      title: 'Extracción de muela del juicio',
      body: 'Autorizo la extracción de la muela del juicio.\n\nEntiendo los riesgos.',
    });
    expect(created.statusCode, created.body).toBe(201);
    const templateId = created.json<ConsentTemplateDto>().id;
    const published = await world.api.post(`/consent/templates/${templateId}/publish`, world.admin);
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json<ConsentTemplateDetailResponse>().versions).toHaveLength(1);
    const asked = await world.api.post('/consents/requests', world.reception, {
      patientId,
      templateId,
      method: 'portal',
    });
    expect(asked.statusCode, asked.body).toBe(201);
    expect(asked.json<CreateConsentRequestResponse>().notice).toBe('sent');

    // Listed, as waiting for the signature.
    const listed = await visitor.get('/portal/consents');
    expect(listed.statusCode, listed.body).toBe(200);
    const before = listed.json<PortalConsentsResponse>();
    expect(before.available).toBe(true);
    expect(before.consents).toHaveLength(1);
    expect(before.consents[0]?.status).toBe('pending');
    const consentId = before.consents[0]?.id ?? '';

    // The text the patient is asked to sign.
    const read = await visitor.get(`/portal/consents/${consentId}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json<PortalConsentDetailDto>().body).toContain('muela del juicio');

    // Signed, in their own words.
    const signed = await visitor.post(`/portal/consents/${consentId}/sign`, {
      accepted: true,
      signerName: 'Paciente Portal',
      signature: { kind: 'typed', value: 'Paciente Portal' },
    });
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.json<PortalConsentResponse>().consent.status).toBe('signed');
    const after = (await visitor.get('/portal/consents')).json<PortalConsentsResponse>();
    expect(after.consents.map((consent) => consent.status)).toEqual(['signed']);

    // The signed record comes down as a PDF, through the one door of the portal.
    const link = await visitor.post(`/portal/consents/${consentId}/download-link`, {});
    expect(link.statusCode, link.body).toBe(200);
    const file = await visitor.get(link.json<PortalDownloadLinkResponse>().url);
    expect(file.statusCode, file.body).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    // One download, one read in the trail: asking for the link wrote none.
    expect(await auditsOf('consent.read', consentId)).toHaveLength(1);
  });
});

describe('a prescription, through the portal and the prescriptions module', () => {
  async function issuedTo(patientId: string) {
    const issued = await world.api.post('/prescriptions', world.doctor, {
      clientKey: randomUUID(),
      patientId,
      items: [AMOXICILLIN],
    });
    expect(issued.statusCode, issued.body).toBe(201);
    const made = issued.json<PrescriptionDto>();
    expect(made.status).toBe('issued');
    return made;
  }

  it('is listed with its document, and downloading it writes exactly one entry of prescription.downloaded', async () => {
    const { visitor } = await portalPatient();
    const patient = await portalPatient();
    const made = await issuedTo(patient.patientId);

    // The patient of another session sees nothing of it.
    const other = (await visitor.get('/portal/prescriptions')).json<PortalPrescriptionsResponse>();
    expect(other.prescriptions).toEqual([]);

    const listed = await patient.visitor.get('/portal/prescriptions');
    expect(listed.statusCode, listed.body).toBe(200);
    const body = listed.json<PortalPrescriptionsResponse>();
    expect(body.available).toBe(true);
    expect(body.prescriptions).toHaveLength(1);
    expect(body.prescriptions[0]).toMatchObject({
      id: made.id,
      status: 'issued',
      hasDocument: true,
    });
    // Nothing about the medication is listed.
    expect(listed.body).not.toContain('Amoxicilina');

    // Asking for the link is not a download; using it is.
    const link = await patient.visitor.post(`/portal/prescriptions/${made.id}/download-link`, {});
    expect(link.statusCode, link.body).toBe(200);
    expect(await auditsOf('prescription.downloaded', made.id)).toHaveLength(0);
    const file = await patient.visitor.get(link.json<PortalDownloadLinkResponse>().url);
    expect(file.statusCode, file.body).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const downloaded = await auditsOf('prescription.downloaded', made.id);
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]).toMatchObject({
      outcome: 'allow',
      actingRole: 'patient',
      patientId: patient.patientId,
    });
    expect(await auditsOf('portal.download', made.id)).toHaveLength(1);
  });

  it('does not open the prescription of another patient', async () => {
    const owner = await portalPatient();
    const stranger = await portalPatient();
    const made = await issuedTo(owner.patientId);

    const link = await stranger.visitor.post(`/portal/prescriptions/${made.id}/download-link`, {});

    expect(link.statusCode).toBe(404);
    expect(await auditsOf('prescription.downloaded', made.id)).toHaveLength(0);
  });
});
