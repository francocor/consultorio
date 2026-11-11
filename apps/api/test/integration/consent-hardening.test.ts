import { randomUUID } from 'node:crypto';

import type {
  ConsentRequestDto,
  ConsentTemplateDetailResponse,
  ConsentTemplateDto,
  CreateConsentRequestResponse,
  PortalConsentDetailDto,
  PortalConsentsResponse,
  PortalDownloadLinkResponse,
  Problem,
  SignedConsentDto,
} from '@consultorio/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { careAssignment } from '../../src/db/schema/care.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { Visitor } from '../support/booking-world.js';
import { allText, readPdf } from '../support/pdf.js';
import { createPortalWorld, type PortalWorld } from '../support/portal-world.js';

/**
 * JD-S5 R1, the consent that a patient signs in the portal:
 *
 * - S5-5: the mark is really decoded and bounded, the signer comes from the link and not from the
 *   body, and the name that was typed is kept;
 * - B-S4: the signature binds to the text that was shown (its fingerprint travels back);
 * - B-T5: a template that was retired is not signed any more;
 * - S5-10: declining a consent is in the trail, with the author;
 * - B-W7: a signed record that no longer matches its fingerprint says so, in the document and in
 *   the trail;
 * - S5-8: the PDF of a record is streamed from memory and written nowhere.
 */
const SLUG = 'consent-hardening';
let runtime: DbHandle;
let world: PortalWorld;
let admin: pg.Client;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createPortalWorld(runtime, { slug: SLUG });
  admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await world.close();
  await runtime.close();
});

const NOTE = 'Presentó su DNI y la partida de nacimiento.';
const problemOf = (response: LightMyRequestResponse) => response.json<Problem>();

/** A real PNG, as the pad draws one. */
const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;

const auditsOf = (action: string, resourceId: string) =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, action as never), eq(auditEvent.resourceId, resourceId))),
  );

/** Makes the doctor treat the patient, so the doctor can open the signed record. */
async function treatedByDoctor(patientId: string) {
  await world.inTenant((tx) =>
    tx.insert(careAssignment).values({
      tenantId: world.tenant.id,
      patientId,
      professionalId: world.doctor.professionalId,
      assignedBy: randomUUID(),
    }),
  );
}

let templates = 0;
async function publishedTemplate() {
  templates += 1;
  const created = await world.api.post('/consent/templates', world.admin, {
    title: `Procedimiento ${String(templates)}`,
    body: 'Autorizo el procedimiento descrito.\n\nEntiendo los riesgos.',
  });
  expect(created.statusCode, created.body).toBe(201);
  const templateId = created.json<ConsentTemplateDto>().id;
  const published = await world.api.post(`/consent/templates/${templateId}/publish`, world.admin);
  expect(published.statusCode, published.body).toBe(200);
  expect(published.json<ConsentTemplateDetailResponse>().versions).toHaveLength(1);
  return templateId;
}

async function request(patientId: string, templateId: string, method: 'portal' | 'in_person') {
  const asked = await world.api.post('/consents/requests', world.reception, {
    patientId,
    templateId,
    method,
  });
  expect(asked.statusCode, asked.body).toBe(201);
  return asked.json<CreateConsentRequestResponse>().request;
}

/** What the screen shows and sends back: the detail with the fingerprint of the text. */
async function detailOf(visitor: Visitor, consentId: string) {
  const response = await visitor.get(`/portal/consents/${consentId}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<PortalConsentDetailDto>();
}

const typed = (name: string) => ({ kind: 'typed' as const, value: name });

/** A patient with an account, treated by the doctor, with a consent waiting in the portal. */
async function waitingPatient() {
  const session = await world.patientSession();
  await treatedByDoctor(session.patientId);
  const templateId = await publishedTemplate();
  const consent = await request(session.patientId, templateId, 'portal');
  return { ...session, templateId, consentId: consent.id };
}

/** A minor with a representative who signs in; the consent waits in the portal. */
async function waitingMinor() {
  const parentEmail = `padre-${randomUUID().slice(0, 6)}@example.test`;
  const child = await world.patientWith({ birthDate: '2020-09-14', email: null });
  await world.inviteOk(child, { email: parentEmail, relation: 'mother', verificationNote: NOTE });
  await world.activate(world.activationPathSentTo(parentEmail));
  const visitor = await world.signInAs(parentEmail);
  await treatedByDoctor(child);
  const consent = await request(child, await publishedTemplate(), 'portal');
  return { visitor, child, consentId: consent.id };
}

const REPRESENTATIVE = {
  fullName: 'María Gómez',
  nationalId: '30111222',
  relation: 'father' as const,
};

describe('S5-5: the mark is a real image of a reasonable size', () => {
  it('refuses a corrupt image, a truncated one, garbage after a valid header and a huge one, and signs nothing', async () => {
    const { visitor, consentId } = await waitingPatient();
    const detail = await detailOf(visitor, consentId);
    const valid = await png(300, 100);
    const attempts = {
      corrupt: Buffer.concat([valid.subarray(0, 8), Buffer.from('this is not a png at all')]),
      truncated: valid.subarray(0, Math.floor(valid.length / 2)),
      headerThenGarbage: Buffer.concat([valid.subarray(0, 33), Buffer.alloc(200, 7)]),
      huge: await png(3_000, 3_000),
    };

    for (const [name, bytes] of Object.entries(attempts)) {
      const response = await visitor.post(`/portal/consents/${consentId}/sign`, {
        accepted: true,
        contentHash: detail.contentHash,
        signerName: 'Paciente Portal',
        signature: { kind: 'drawn', value: dataUrl(bytes) },
      });
      expect(response.statusCode, `${name}: ${response.body}`).toBe(422);
      expect(problemOf(response).code, name).toBe('consent_mark_invalid');
    }
    const listed = (await visitor.get('/portal/consents')).json<PortalConsentsResponse>();
    expect(listed.consents[0]?.status).toBe('pending');

    const signed = await visitor.post(`/portal/consents/${consentId}/sign`, {
      accepted: true,
      contentHash: detail.contentHash,
      signerName: 'Paciente Portal',
      signature: { kind: 'drawn', value: dataUrl(valid) },
    });
    expect(signed.statusCode, signed.body).toBe(200);
  });

  it('refuses a mark that is not a PNG data URL, and a typed mark of more than 120 characters', async () => {
    const { visitor, consentId } = await waitingPatient();
    const detail = await detailOf(visitor, consentId);
    const sign = (signature: unknown) =>
      visitor.post(`/portal/consents/${consentId}/sign`, {
        accepted: true,
        contentHash: detail.contentHash,
        signerName: 'Paciente Portal',
        signature,
      });

    for (const signature of [
      { kind: 'drawn', value: 'https://evil.example/pixel.png' },
      { kind: 'drawn', value: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
      typed('x'.repeat(121)),
    ]) {
      expect((await sign(signature)).statusCode, JSON.stringify(signature).slice(0, 40)).toBe(400);
    }
    expect((await sign(typed('Paciente Portal'))).statusCode).toBe(200);
  });
});

describe('S5-5: who signs is decided by the link, and the name that was typed is kept', () => {
  it('keeps the full name the patient typed with the record, which the doctor reads', async () => {
    const { visitor, consentId } = await waitingPatient();
    const detail = await detailOf(visitor, consentId);

    const signed = await visitor.post(`/portal/consents/${consentId}/sign`, {
      accepted: true,
      contentHash: detail.contentHash,
      signerName: 'Paciente Portal Completo',
      signature: { kind: 'drawn', value: dataUrl(await png(300, 100)) },
    });
    expect(signed.statusCode, signed.body).toBe(200);

    const record = await world.api.get(`/consents/requests/${consentId}`, world.doctor);
    expect(record.statusCode, record.body).toBe(200);
    expect(record.json<SignedConsentDto>()).toMatchObject({
      signerKind: 'patient',
      signerName: 'Paciente Portal Completo',
      fingerprintValid: true,
    });
  });

  it('makes the representative of a minor sign as the representative, with the relation of the link', async () => {
    const { visitor, consentId } = await waitingMinor();
    const detail = await detailOf(visitor, consentId);
    expect(detail.requiresRepresentative).toBe(true);
    const body = {
      accepted: true,
      contentHash: detail.contentHash,
      signerName: 'María Gómez',
      signature: typed('María Gómez'),
    };

    // Without the data of the representative: refused.
    const missing = await visitor.post(`/portal/consents/${consentId}/sign`, body);
    expect(missing.statusCode, missing.body).toBe(422);
    expect(problemOf(missing).code).toBe('consent_representative_required');
    // With them, signing is the representative's, whatever the form said the relation was.
    const done = await visitor.post(`/portal/consents/${consentId}/sign`, {
      ...body,
      representative: REPRESENTATIVE,
    });
    expect(done.statusCode, done.body).toBe(200);

    const record = (
      await world.api.get(`/consents/requests/${consentId}`, world.doctor)
    ).json<SignedConsentDto>();
    expect(record.signerKind).toBe('representative');
    expect(record.representative).toMatchObject({ name: 'María Gómez', relation: 'mother' });
    expect(record.signerName).toBe('María Gómez');
  });

  it('does not let the representative of an ADULT sign for them, nor a person send representative data', async () => {
    // An adult who authorized a representative once (made straight in the database).
    const adultEmail = `adulto-${randomUUID().slice(0, 6)}@example.test`;
    const parentEmail = `rep-${randomUUID().slice(0, 6)}@example.test`;
    const adult = await world.patientWith({ birthDate: '1985-03-10', email: adultEmail });
    await world.inviteOk(adult);
    await world.activate(world.activationPathSentTo(adultEmail));
    await world.inTenant(async (tx) => {
      const identity = await tx.execute<{ id: string }>(
        sql`insert into portal_identity (tenant_id, email, status, activated_at)
              values (${world.tenant.id}, ${parentEmail}, 'active', now()) returning id`,
      );
      await tx.execute(
        sql`insert into portal_link (tenant_id, portal_identity_id, patient_id, relationship, relation, verification_note)
              values (${world.tenant.id}, ${identity.rows[0]?.id ?? ''}, ${adult}, 'representative', 'mother', 'autorizada por la persona')`,
      );
    });
    await treatedByDoctor(adult);
    const consent = await request(adult, await publishedTemplate(), 'portal');
    const asRepresentative = await world.signInAs(parentEmail);
    const asSelf = await world.signInAs(adultEmail);

    const detail = await detailOf(asRepresentative, consent.id);
    const forged = await asRepresentative.post(`/portal/consents/${consent.id}/sign`, {
      accepted: true,
      contentHash: detail.contentHash,
      signerName: 'Madre Del Adulto',
      signature: typed('Madre Del Adulto'),
      representative: REPRESENTATIVE,
    });
    const withData = await asSelf.post(`/portal/consents/${consent.id}/sign`, {
      accepted: true,
      contentHash: detail.contentHash,
      signerName: 'Paciente Adulto',
      signature: typed('Paciente Adulto'),
      representative: REPRESENTATIVE,
    });

    expect(forged.statusCode, forged.body).toBe(409);
    expect(problemOf(forged).code).toBe('consent_signer_not_allowed');
    expect(withData.statusCode, withData.body).toBe(422);
    expect(problemOf(withData).code).toBe('consent_representative_unexpected');
    const own = await asSelf.post(`/portal/consents/${consent.id}/sign`, {
      accepted: true,
      contentHash: detail.contentHash,
      signerName: 'Paciente Adulto',
      signature: typed('Paciente Adulto'),
    });
    expect(own.statusCode, own.body).toBe(200);
  });
});

describe('B-S4: the signature binds to the text that was shown', () => {
  it('refuses a fingerprint that is not the one of the version, and one that is missing', async () => {
    const { visitor, consentId } = await waitingPatient();
    const detail = await detailOf(visitor, consentId);
    const sign = (extra: Record<string, unknown>) =>
      visitor.post(`/portal/consents/${consentId}/sign`, {
        accepted: true,
        signerName: 'Paciente Portal',
        signature: typed('Paciente Portal'),
        ...extra,
      });

    const wrong = await sign({ contentHash: 'b'.repeat(64) });
    const missing = await sign({});

    expect(wrong.statusCode, wrong.body).toBe(409);
    expect(problemOf(wrong).code).toBe('consent_version_mismatch');
    expect(missing.statusCode).toBe(400);
    expect((await sign({ contentHash: detail.contentHash })).statusCode).toBe(200);
  });
});

describe('B-T5: a template that was retired is not signed any more', () => {
  it('refuses to show and to sign a request made before the template was retired', async () => {
    const { visitor, templateId, consentId } = await waitingPatient();
    const detail = await detailOf(visitor, consentId);
    const retired = await world.api.post(`/consent/templates/${templateId}/retire`, world.admin);
    expect(retired.statusCode, retired.body).toBe(200);

    const shown = await visitor.get(`/portal/consents/${consentId}`);
    const signed = await visitor.post(`/portal/consents/${consentId}/sign`, {
      accepted: true,
      contentHash: detail.contentHash,
      signerName: 'Paciente Portal',
      signature: typed('Paciente Portal'),
    });

    expect(shown.statusCode, shown.body).toBe(409);
    expect(problemOf(shown).code).toBe('consent_template_retired');
    expect(signed.statusCode, signed.body).toBe(409);
    expect(problemOf(signed).code).toBe('consent_template_retired');
  });

  it('still signs the version the patient was shown when a newer one was published meanwhile', async () => {
    const { visitor, templateId, consentId } = await waitingPatient();
    const detail = await detailOf(visitor, consentId);
    const edited = await world.api.patch(`/consent/templates/${templateId}`, world.admin, {
      body: 'Un texto nuevo, publicado mientras el paciente leía.',
    });
    expect(edited.statusCode, edited.body).toBe(200);

    const signed = await visitor.post(`/portal/consents/${consentId}/sign`, {
      accepted: true,
      contentHash: detail.contentHash,
      signerName: 'Paciente Portal',
      signature: typed('Paciente Portal'),
    });

    expect(signed.statusCode, signed.body).toBe(200);
  });
});

describe('S5-10: declining a consent is in the trail, with the author', () => {
  it('writes consent.declined naming the member of the staff who recorded it', async () => {
    const patient = await world.patientWith({ birthDate: '1985-03-10' });
    const consent = await request(patient, await publishedTemplate(), 'in_person');

    const declined = await world.api.post(
      `/consents/requests/${consent.id}/decline`,
      world.reception,
    );

    expect(declined.statusCode, declined.body).toBe(200);
    expect(declined.json<ConsentRequestDto>().status).toBe('declined');
    const entries = await auditsOf('consent.declined', consent.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      outcome: 'allow',
      patientId: patient,
      actorUserId: world.reception.user.id,
    });
    // By id and version, never by title.
    expect(JSON.stringify(entries[0]?.metadata)).not.toContain('Procedimiento');
  });
});

/** Changes the stored fingerprint of a signature the way damage or tampering would (triggers off). */
async function damage(consentId: string) {
  await admin.query('BEGIN');
  try {
    await admin.query(`SET LOCAL session_replication_role = replica`);
    await admin.query(
      `update consent_signature set content_fingerprint = repeat('0', 64) where request_id = $1`,
      [consentId],
    );
  } finally {
    await admin.query('COMMIT');
  }
}

describe('B-W7: a signed record that does not match its fingerprint says so', () => {
  async function downloaded(visitor: Visitor, consentId: string) {
    const link = await visitor.post(`/portal/consents/${consentId}/download-link`, {});
    expect(link.statusCode, link.body).toBe(200);
    const file = await visitor.get(link.json<PortalDownloadLinkResponse>().url);
    expect(file.statusCode, file.body).toBe(200);
    return allText(readPdf(file.rawPayload));
  }

  it('prints a notice and writes consent.integrity_failed when the stored fingerprint was changed', async () => {
    const { visitor, consentId } = await waitingPatient();
    const detail = await detailOf(visitor, consentId);
    await visitor.post(`/portal/consents/${consentId}/sign`, {
      accepted: true,
      contentHash: detail.contentHash,
      signerName: 'Paciente Portal',
      signature: typed('Paciente Portal'),
    });
    const intact = await downloaded(visitor, consentId);
    expect(intact).not.toContain('integridad');
    expect(await auditsOf('consent.integrity_failed', consentId)).toHaveLength(0);

    await damage(consentId);
    const broken = await downloaded(visitor, consentId);

    expect(broken).toContain('ATENCIÓN');
    expect(broken).toContain('integridad');
    const failures = await auditsOf('consent.integrity_failed', consentId);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ outcome: 'deny', reason: 'fingerprint_mismatch' });
  });
});

describe('S5-8: the PDF of a record is streamed and written nowhere', () => {
  it('leaves nothing under the prefix of the rendered files, also when the response ends', async () => {
    const { visitor, consentId } = await waitingPatient();
    const detail = await detailOf(visitor, consentId);
    await visitor.post(`/portal/consents/${consentId}/sign`, {
      accepted: true,
      contentHash: detail.contentHash,
      signerName: 'Paciente Portal',
      signature: typed('Paciente Portal'),
    });
    const link = await visitor.post(`/portal/consents/${consentId}/download-link`, {});

    const file = await visitor.get(link.json<PortalDownloadLinkResponse>().url);

    expect(file.statusCode, file.body).toBe(200);
    expect(file.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(file.headers['content-length']).toBe(String(file.rawPayload.length));
    expect(world.storage.keys().filter((key) => key.includes('portal-rendered'))).toEqual([]);
  });
});
