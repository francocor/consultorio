import { randomBytes, randomUUID } from 'node:crypto';

import type {
  AuditAction,
  ConsentListResponse,
  ConsentRequestDto,
  ConsentSigningViewDto,
  CreateConsentRequestResponse,
  SignedConsentDto,
  ConsentTemplateDetailResponse,
  ConsentTemplateDto,
  AppointmentConsentStatusDto,
  ConsentRequirementsResponse,
} from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFakeEmailSender } from '../../src/adapters/fake-email/index.js';
import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { careAssignment } from '../../src/db/schema/care.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import {
  exportConsentTemplates,
  exportSignedConsents,
} from '../../src/modules/consent/application/export-contributor.js';
import { signatureFingerprint } from '../../src/modules/consent/domain/fingerprint.js';
import {
  CONSENT_EXPIRE_JOB,
  createConsentExpireJob,
  createConsentPortal,
} from '../../src/modules/consent/index.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, SYSTEM_USER_ID } from '../../src/platform/db/tenant-context.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import { asSystem, createDocumentsHarness, type DocumentsHarness } from '../support/documents.js';
import { insertAppointmentRow } from '../support/fixture-helpers.js';
import { createTestPatient } from '../support/patients.js';
import { asTenant } from '../support/tenants.js';

/**
 * Consent requests, signing, revocation, the warning on appointments, the notice and the expiry
 * (S5.03, tasks 5.13 to 5.15; informed-consent, "Requesting a consent", "Signature capture and
 * binding", "Minors, incapacitated patients and representatives", "Revocation", "Visibility and
 * access control" and "Read-only tenant, export and language").
 */
let runtime: DbHandle;
let h: DocumentsHarness;
let email: ReturnType<typeof createFakeEmailSender>;
const keys = createTenantKeys({
  kms: createLocalKeyManagement(randomBytes(32).toString('base64')),
});

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  email = createFakeEmailSender();
  h = await createDocumentsHarness(runtime, 'consent-signing', { email, keys });
});

afterAll(async () => {
  await h.close();
  await runtime.close();
});

// A 1x1 PNG, enough for a drawn signature.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const DRAWN = `data:image/png;base64,${PNG.toString('base64')}`;

const TITLE = 'Extracción de muela del juicio';
const BODY_ONE = 'Autorizo la extracción de la muela del juicio.\n\nEntiendo los riesgos.';

let counter = 0;

interface World {
  templateId: string;
  versionId: string;
}

/** A published template with one version, made through the API the way staff make it. */
async function publishedTemplate(
  overrides: { title?: string; body?: string } = {},
): Promise<World> {
  counter += 1;
  const created = await h.api.post('/consent/templates', h.sessions.admin, {
    title: overrides.title ?? `${TITLE} ${String(counter)}`,
    body: overrides.body ?? BODY_ONE,
  });
  expect(created.statusCode, created.body).toBe(201);
  const templateId = created.json<ConsentTemplateDto>().id;
  const published = await h.api.post(`/consent/templates/${templateId}/publish`, h.sessions.admin);
  expect(published.statusCode, published.body).toBe(200);
  return {
    templateId,
    versionId: published.json<ConsentTemplateDetailResponse>().versions[0]?.id ?? '',
  };
}

async function editTemplate(templateId: string, body: string): Promise<string> {
  const edited = await h.api.patch(`/consent/templates/${templateId}`, h.sessions.admin, { body });
  expect(edited.statusCode, edited.body).toBe(200);
  return edited.json<ConsentTemplateDetailResponse>().versions[0]?.id ?? '';
}

/** A patient treated by the professional of the harness. */
async function newPatient(
  values: { email?: string | null; birthDate?: string; treated?: boolean } = {},
): Promise<string> {
  const patientId = await createTestPatient(runtime, h.tenant.id, {
    givenNames: 'Ana',
    ...(values.email === undefined
      ? { email: `ana${randomUUID().slice(0, 8)}@example.test` }
      : { email: values.email }),
    ...(values.birthDate === undefined ? {} : { birthDate: values.birthDate }),
  });
  if (values.treated !== false) {
    await asTenant(runtime, h.tenant.id, (tx) =>
      tx.insert(careAssignment).values({
        tenantId: h.tenant.id,
        patientId,
        professionalId: h.professionalId,
        assignedBy: randomUUID(),
      }),
    );
  }
  return patientId;
}

async function request(
  patientId: string,
  templateId: string,
  options: { method?: 'in_person' | 'portal'; session?: typeof h.sessions.reception } = {},
) {
  const response = await h.api.post('/consents/requests', options.session ?? h.sessions.reception, {
    patientId,
    templateId,
    method: options.method ?? 'in_person',
  });
  return response;
}

async function requestOk(
  patientId: string,
  templateId: string,
  options: { method?: 'in_person' | 'portal' } = {},
): Promise<ConsentRequestDto> {
  const response = await request(patientId, templateId, options);
  expect(response.statusCode, response.body).toBe(201);
  return response.json<CreateConsentRequestResponse>().request;
}

const typedMark = (name = 'Ana Pérez') => ({ kind: 'typed' as const, name });

function signBody(versionId: string, overrides: Record<string, unknown> = {}) {
  return { versionId, accepted: true, signer: 'patient', mark: typedMark(), ...overrides };
}

async function sign(
  requestId: string,
  body: Record<string, unknown>,
  session = h.sessions.reception,
) {
  return h.api.post(`/consents/requests/${requestId}/sign`, session, body);
}

async function signedConsent(world: World, patientId?: string) {
  const patient = patientId ?? (await newPatient());
  const created = await requestOk(patient, world.templateId);
  const response = await sign(created.id, signBody(created.versionId));
  expect(response.statusCode, response.body).toBe(200);
  return { patientId: patient, requestId: created.id, versionId: created.versionId };
}

async function auditRows(action: AuditAction, resourceId: string) {
  const rows = await asSystem(runtime, h.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, h.tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return rows.filter((row) => row.resourceId === resourceId);
}

type StoredSignature = {
  template_version_id: string;
  signer_kind: string;
  method: string;
  content_fingerprint: string;
  signed_at: string;
  recorded_by: string | null;
  portal_identity_id: string | null;
  payload_enc: Buffer;
};

/** The row as the database holds it, read the way the portal of the patient reads it. */
async function storedSignature(patientId: string, requestId: string): Promise<StoredSignature> {
  return asTenant(runtime, h.tenant.id, async (tx) => {
    await tx.execute(sql`select set_config('app.consent_portal_patient', ${patientId}, true)`);
    const rows = await tx.execute<StoredSignature>(
      sql`SELECT template_version_id, signer_kind, method, content_fingerprint, signed_at,
                 recorded_by, portal_identity_id, payload_enc
            FROM consent_signature WHERE request_id = ${requestId}`,
    );
    const row = rows.rows[0];
    if (!row) throw new Error('no signature');
    return row;
  });
}

describe('requesting a consent', () => {
  it('lets reception ask for the latest published version, and audits it without the title', async () => {
    const world = await publishedTemplate();
    await editTemplate(world.templateId, 'Segunda versión del texto.');
    const patientId = await newPatient();

    const response = await request(patientId, world.templateId);

    expect(response.statusCode, response.body).toBe(201);
    const body = response.json<CreateConsentRequestResponse>();
    expect(body.notice).toBe('not_needed');
    expect(body.request).toMatchObject({
      patientId,
      templateId: world.templateId,
      versionNumber: 2,
      status: 'pending',
      method: 'in_person',
    });
    expect(body.request.versionId).not.toBe(world.versionId);
    const rows = await auditRows('consent.requested', body.request.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.patientId).toBe(patientId);
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain('Extracción');
    expect(rows[0]?.metadata).toMatchObject({ version: 2, method: 'in_person' });
  });

  it('is open to a professional too, and closed to the administration', async () => {
    const world = await publishedTemplate();
    const patientId = await newPatient();

    expect(
      (await request(patientId, world.templateId, { session: h.sessions.professional })).statusCode,
    ).toBe(201);
    const other = await newPatient();
    for (const session of [h.sessions.admin, h.sessions.owner]) {
      expect((await request(other, world.templateId, { session })).statusCode).toBe(403);
    }
  });

  it('refuses a template that is a draft or retired, and a patient or template that does not exist', async () => {
    const patientId = await newPatient();
    const draft = (
      await h.api.post('/consent/templates', h.sessions.admin, {
        title: 'Borrador',
        body: 'Texto.',
      })
    ).json<ConsentTemplateDto>();
    const retired = await publishedTemplate();
    await h.api.post(`/consent/templates/${retired.templateId}/retire`, h.sessions.admin);

    for (const templateId of [draft.id, retired.templateId]) {
      const response = await request(patientId, templateId);
      expect(response.statusCode).toBe(409);
      expect(response.json<{ code: string }>().code).toBe('consent_template_not_offered');
    }
    expect((await request(randomUUID(), retired.templateId)).statusCode).toBe(404);
    expect((await request(patientId, randomUUID())).statusCode).toBe(404);
  });

  it('allows one live request per patient and template, and a new one after it ended', async () => {
    const world = await publishedTemplate();
    const patientId = await newPatient();
    const first = await requestOk(patientId, world.templateId);

    const again = await request(patientId, world.templateId);
    expect(again.statusCode).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('consent_request_pending');

    const declined = await h.api.post(
      `/consents/requests/${first.id}/decline`,
      h.sessions.reception,
    );
    expect(declined.statusCode, declined.body).toBe(200);
    expect(declined.json<ConsentRequestDto>().status).toBe('declined');
    expect((await request(patientId, world.templateId)).statusCode).toBe(201);
  });

  it('closes a request that waited past its date when the same consent is asked again', async () => {
    const world = await publishedTemplate();
    const patientId = await newPatient();
    const stale = await asTenant(runtime, h.tenant.id, async (tx) => {
      const { insertConsentRequest } = await import('../support/consent-rows.js');
      return insertConsentRequest(
        tx,
        h.tenant.id,
        { patient_id: patientId, template_version_id: world.versionId },
        { expiresAt: new Date(Date.now() - 60_000) },
      );
    });

    const response = await request(patientId, world.templateId);

    expect(response.statusCode, response.body).toBe(201);
    expect((await auditRows('consent.expired', stale)).length).toBe(1);
    const list = await h.api.get(`/patients/${patientId}/consents`, h.sessions.professional);
    expect(
      list
        .json<ConsentListResponse>()
        .consents.map((entry) => entry.status)
        .sort(),
    ).toEqual(['expired', 'pending']);
  });

  it('tells the patient by email when it is signed in the portal, with no title in the message', async () => {
    const world = await publishedTemplate({ title: 'Cirugía de rodilla' });
    const address = `paciente${randomUUID().slice(0, 8)}@example.test`;
    const patientId = await newPatient({ email: address });
    email.clear();

    const response = await request(patientId, world.templateId, { method: 'portal' });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<CreateConsentRequestResponse>().notice).toBe('sent');
    const sent = email.lastTo(address);
    expect(sent).toBeDefined();
    const everything =
      `${sent?.subject ?? ''} ${sent?.text ?? ''} ${sent?.html ?? ''}`.toLowerCase();
    expect(everything).toContain('/portal');
    // The one notice of the portal (kind consent_request): it says a document waits, never which.
    expect(sent?.subject).toMatch(/^Tiene un documento esperando en el portal de /);
    expect(sent?.text).toContain('le dejó un documento para revisar en su portal de pacientes');
    expect(everything).not.toContain('consentimiento');
    for (const word of ['cirugía', 'rodilla', 'extracción']) {
      expect(everything, word).not.toContain(word);
    }
  });

  it('says so when the patient could not be told, and writes nothing to a patient with no address', async () => {
    const world = await publishedTemplate();
    const patientId = await newPatient({ email: null });
    email.clear();

    const response = await request(patientId, world.templateId, { method: 'portal' });

    expect(response.statusCode).toBe(201);
    expect(response.json<CreateConsentRequestResponse>().notice).toBe('not_sent');
    expect(email.sent).toHaveLength(0);
  });
});

describe('signing in person', () => {
  it('records the signature against version 3, with its time and fingerprint', async () => {
    const world = await publishedTemplate();
    await editTemplate(world.templateId, 'Texto de la versión 2.');
    const v3 = await editTemplate(world.templateId, 'Texto de la versión 3.');
    const patientId = await newPatient();
    const created = await requestOk(patientId, world.templateId);
    expect(created.versionNumber).toBe(3);

    const view = await h.api.get(`/consents/requests/${created.id}/signing`, h.sessions.reception);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json<ConsentSigningViewDto>().version).toMatchObject({
      id: v3,
      number: 3,
      body: 'Texto de la versión 3.',
    });

    const response = await sign(created.id, signBody(v3));

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<ConsentRequestDto>()).toMatchObject({
      status: 'signed',
      versionNumber: 3,
      versionId: v3,
    });
    expect(response.json<ConsentRequestDto>().signedAt).not.toBeNull();
    const stored = await storedSignature(patientId, created.id);
    expect(stored).toMatchObject({
      template_version_id: v3,
      signer_kind: 'patient',
      method: 'in_person',
      recorded_by: h.sessions.reception.user.id,
      portal_identity_id: null,
    });
    expect(stored.content_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const rows = await auditRows('consent.signed', created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({ version: 3, method: 'in_person', signer: 'patient' });
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain('Ana Pérez');
  });

  it('keeps the name, the representative and the evidence encrypted in the row', async () => {
    const world = await publishedTemplate();
    const patientId = await newPatient({ birthDate: '2018-03-02' });
    const created = await requestOk(patientId, world.templateId);
    await sign(
      created.id,
      signBody(created.versionId, {
        signer: 'representative',
        representative: { name: 'Luis Gómez', nationalId: '20123456', relation: 'padre' },
        mark: typedMark('Luis Gómez'),
      }),
    );

    const stored = await storedSignature(patientId, created.id);

    const raw = stored.payload_enc.toString('latin1');
    for (const secret of ['Luis', 'Gómez', '20123456', 'padre', 'vitest-browser']) {
      expect(raw, secret).not.toContain(secret);
    }
  });

  it('binds to the version the signer was shown even if a newer one was published meanwhile', async () => {
    const world = await publishedTemplate();
    const patientId = await newPatient();
    const created = await requestOk(patientId, world.templateId);
    const v2 = await editTemplate(
      world.templateId,
      'Se publicó una versión nueva mientras firmaba.',
    );

    // The signer is still looking at version 1.
    const response = await sign(created.id, signBody(created.versionId));

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<ConsentRequestDto>().versionNumber).toBe(1);
    expect((await storedSignature(patientId, created.id)).template_version_id).toBe(
      world.versionId,
    );
    expect(v2).not.toBe(world.versionId);
  });

  it('refuses a signature that names another version than the one shown', async () => {
    const world = await publishedTemplate();
    const patientId = await newPatient();
    const created = await requestOk(patientId, world.templateId);
    const v2 = await editTemplate(world.templateId, 'Otro texto.');

    const response = await sign(created.id, signBody(v2));

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('consent_version_mismatch');
    expect(
      (
        await h.api.get(`/patients/${patientId}/consents`, h.sessions.professional)
      ).json<ConsentListResponse>().consents[0]?.status,
    ).toBe('pending');
  });

  it('rejects a signature without the explicit acceptance, and leaves the request pending', async () => {
    const world = await publishedTemplate();
    const patientId = await newPatient();
    const created = await requestOk(patientId, world.templateId);

    const response = await sign(created.id, signBody(created.versionId, { accepted: false }));

    expect(response.statusCode).toBe(422);
    expect(response.json<{ code: string }>().code).toBe('consent_acceptance_required');
    expect(await auditRows('consent.signed', created.id)).toHaveLength(0);
    const again = await sign(created.id, signBody(created.versionId));
    expect(again.statusCode).toBe(200);
  });

  it('takes a drawn signature that is a real image, and refuses one that is not', async () => {
    const world = await publishedTemplate();
    const patientId = await newPatient();
    const created = await requestOk(patientId, world.templateId);

    const notPng = await sign(
      created.id,
      signBody(created.versionId, {
        mark: {
          kind: 'drawn',
          imageDataUrl: `data:image/png;base64,${Buffer.from('hola').toString('base64')}`,
        },
      }),
    );
    const notBase64 = await sign(
      created.id,
      signBody(created.versionId, {
        mark: { kind: 'drawn', imageDataUrl: 'data:image/png;base64,@@@' },
      }),
    );
    expect(notPng.statusCode).toBe(422);
    expect(notPng.json<{ code: string }>().code).toBe('consent_mark_invalid');
    expect(notBase64.json<{ code: string }>().code).toBe('consent_mark_invalid');

    const drawn = await sign(
      created.id,
      signBody(created.versionId, { mark: { kind: 'drawn', imageDataUrl: DRAWN } }),
    );
    expect(drawn.statusCode, drawn.body).toBe(200);
    const detail = await h.api.get(`/consents/requests/${created.id}`, h.sessions.professional);
    expect(detail.json<SignedConsentDto>().mark).toEqual({ kind: 'drawn', imageDataUrl: DRAWN });
  });

  it('cannot be signed twice, and two signatures at once leave one', async () => {
    const world = await publishedTemplate();
    const patientId = await newPatient();
    const created = await requestOk(patientId, world.templateId);

    const [first, second] = await Promise.all([
      sign(created.id, signBody(created.versionId), h.sessions.reception),
      sign(created.id, signBody(created.versionId), h.sessions.professional),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const loser = first.statusCode === 409 ? first : second;
    expect(loser.json<{ code: string }>().code).toBe('consent_request_closed');
    expect(await auditRows('consent.signed', created.id)).toHaveLength(1);
  });

  it('is for requests made to be signed in person: a portal request is signed in the portal', async () => {
    const world = await publishedTemplate();
    const patientId = await newPatient();
    const created = await requestOk(patientId, world.templateId, { method: 'portal' });

    const response = await sign(created.id, signBody(created.versionId));

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('consent_method_mismatch');
  });
});

describe('a request that ran out of time', () => {
  async function expiredRequest(world: World, patientId: string) {
    return asTenant(runtime, h.tenant.id, async (tx) => {
      const { insertConsentRequest } = await import('../support/consent-rows.js');
      return insertConsentRequest(
        tx,
        h.tenant.id,
        { patient_id: patientId, template_version_id: world.versionId },
        { expiresAt: new Date(Date.now() - 60_000) },
      );
    });
  }

  it('shows as expired and cannot be opened or signed', async () => {
    const world = await publishedTemplate();
    const patientId = await newPatient();
    const requestId = await expiredRequest(world, patientId);

    const view = await h.api.get(`/consents/requests/${requestId}/signing`, h.sessions.reception);
    const response = await sign(requestId, signBody(world.versionId));
    const list = await h.api.get(`/patients/${patientId}/consents`, h.sessions.reception);

    expect(view.statusCode).toBe(409);
    expect(view.json<{ code: string }>().code).toBe('consent_request_expired');
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('consent_request_expired');
    expect(list.json<ConsentListResponse>().consents[0]?.status).toBe('expired');
  });

  it('is recorded by the job, once, with an audit entry, and a live request is left alone', async () => {
    const world = await publishedTemplate();
    const stale = await newPatient();
    const live = await newPatient();
    const staleId = await expiredRequest(world, stale);
    const liveRequest = await requestOk(live, world.templateId);
    const definition = createConsentExpireJob({ clock: () => new Date() });
    const run = () =>
      runJob(runtime.db, definition, {
        id: randomUUID(),
        name: CONSENT_EXPIRE_JOB,
        enqueuedAt: new Date(),
        retryCount: 0,
        data: { tenantId: h.tenant.id },
      });

    expect((await run()).status).toBe('completed');
    expect((await run()).status).toBe('completed');

    const states = await asTenant(runtime, h.tenant.id, (tx) =>
      tx.execute<{ id: string; status: string; closed_at: string | null }>(
        sql`SELECT id, status, closed_at FROM consent_request WHERE id IN (${staleId}, ${liveRequest.id})`,
      ),
    );
    const byId = new Map(states.rows.map((row) => [row.id, row]));
    expect(byId.get(staleId)).toMatchObject({ status: 'expired' });
    expect(byId.get(staleId)?.closed_at).not.toBeNull();
    expect(byId.get(liveRequest.id)?.status).toBe('pending');
    const rows = await auditRows('consent.expired', staleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: null, outcome: 'allow' });
  });
});

describe('a minor and a representative', () => {
  it('requires the representative for a minor, who is never marked as the signer', async () => {
    const world = await publishedTemplate();
    const patientId = await newPatient({ birthDate: '2019-06-15' });
    const created = await requestOk(patientId, world.templateId);
    const view = await h.api.get(`/consents/requests/${created.id}/signing`, h.sessions.reception);
    expect(view.json<ConsentSigningViewDto>().requiresRepresentative).toBe(true);

    const asPatient = await sign(created.id, signBody(created.versionId));
    const withoutData = await sign(
      created.id,
      signBody(created.versionId, { signer: 'representative' }),
    );
    expect(asPatient.statusCode).toBe(422);
    expect(asPatient.json<{ code: string }>().code).toBe('consent_representative_required');
    expect(withoutData.statusCode).toBe(422);
    expect(withoutData.json<{ code: string }>().code).toBe('consent_representative_required');

    const representative = { name: 'Luis Gómez', nationalId: '20123456', relation: 'padre' };
    const signed = await sign(
      created.id,
      signBody(created.versionId, {
        signer: 'representative',
        representative,
        mark: typedMark('Luis Gómez'),
      }),
    );
    expect(signed.statusCode, signed.body).toBe(200);
    expect((await storedSignature(patientId, created.id)).signer_kind).toBe('representative');
    const detail = (
      await h.api.get(`/consents/requests/${created.id}`, h.sessions.professional)
    ).json<SignedConsentDto>();
    expect(detail).toMatchObject({ signerKind: 'representative', representative });
    expect(detail.fingerprintValid).toBe(true);
  });

  it('does not ask an adult for a representative, and refuses representative data on their own signature', async () => {
    const world = await publishedTemplate();
    const patientId = await newPatient();
    const created = await requestOk(patientId, world.templateId);
    const view = await h.api.get(`/consents/requests/${created.id}/signing`, h.sessions.reception);
    expect(view.json<ConsentSigningViewDto>().requiresRepresentative).toBe(false);

    const unexpected = await sign(
      created.id,
      signBody(created.versionId, {
        representative: { name: 'Luis Gómez', nationalId: '20123456', relation: 'padre' },
      }),
    );

    expect(unexpected.statusCode).toBe(422);
    expect(unexpected.json<{ code: string }>().code).toBe('consent_representative_unexpected');
    expect((await sign(created.id, signBody(created.versionId))).statusCode).toBe(200);
  });
});

describe('who opens a signed consent', () => {
  it('lets a treating professional open it and audits the read; fingerprint and text are intact', async () => {
    const world = await publishedTemplate();
    const { requestId, patientId } = await signedConsent(world);

    const response = await h.api.get(`/consents/requests/${requestId}`, h.sessions.professional);

    expect(response.statusCode, response.body).toBe(200);
    const record = response.json<SignedConsentDto>();
    expect(record.version.body).toBe(BODY_ONE);
    expect(record.accepted).toBe(true);
    expect(record.mark).toEqual({ kind: 'typed', name: 'Ana Pérez' });
    expect(record.evidence.userAgent).toBe('vitest-browser');
    expect(record.fingerprintValid).toBe(true);
    expect(record.revocation).toBeNull();
    expect(
      signatureFingerprint({
        requestId,
        patientId,
        versionId: record.version.id,
        versionFingerprint: record.version.contentHash,
        signerKind: 'patient',
        representative: null,
        accepted: true,
        method: 'in_person',
        signedAt: record.signedAt,
        mark: { kind: 'typed', value: 'Ana Pérez' },
      }),
    ).toBe(record.contentFingerprint);
    const reads = await auditRows('consent.read', requestId);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ outcome: 'allow', patientId });
    expect(reads[0]?.metadata).toMatchObject({ via: 'view' });
    expect(JSON.stringify(reads[0]?.metadata)).not.toContain('Ana Pérez');
  });

  it('refuses reception, the administration and a professional who does not treat the patient', async () => {
    const world = await publishedTemplate();
    const { requestId } = await signedConsent(world);

    for (const session of [h.sessions.reception, h.sessions.admin, h.sessions.owner]) {
      const response = await h.api.get(`/consents/requests/${requestId}`, session);
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain('Autorizo');
    }
    const colleague = await h.api.get(`/consents/requests/${requestId}`, h.sessions.colleague);
    expect(colleague.statusCode).toBe(403);
    const denials = await asSystem(runtime, h.tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.action, 'access.denied'), eq(auditEvent.resourceId, requestId))),
    );
    expect(denials.some((row) => row.reason === 'consent_record_not_readable')).toBe(true);
    expect((await auditRows('consent.read', requestId)).length).toBe(0);
  });

  it('renders the printable record, audited, and the same bytes every time', async () => {
    const world = await publishedTemplate();
    const { requestId } = await signedConsent(world);

    const first = await h.api.get(
      `/consents/requests/${requestId}/document`,
      h.sessions.professional,
    );
    const second = await h.api.get(
      `/consents/requests/${requestId}/document`,
      h.sessions.professional,
    );

    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers['content-type']).toBe('application/pdf');
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(Buffer.compare(first.rawPayload, second.rawPayload)).toBe(0);
    const reads = await auditRows('consent.read', requestId);
    expect(reads.map((row) => (row.metadata as { via?: string }).via)).toEqual([
      'document',
      'document',
    ]);
    expect(
      (await h.api.get(`/consents/requests/${requestId}/document`, h.sessions.reception))
        .statusCode,
    ).toBe(403);
  });

  it('renders a drawn signature into the record', async () => {
    const world = await publishedTemplate();
    const patientId = await newPatient();
    const created = await requestOk(patientId, world.templateId);
    await sign(
      created.id,
      signBody(created.versionId, { mark: { kind: 'drawn', imageDataUrl: DRAWN } }),
    );

    const response = await h.api.get(
      `/consents/requests/${created.id}/document`,
      h.sessions.professional,
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('keeps a pending request unreadable as a signed record', async () => {
    const world = await publishedTemplate();
    const created = await requestOk(await newPatient(), world.templateId);

    const response = await h.api.get(`/consents/requests/${created.id}`, h.sessions.professional);

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('consent_not_signed');
  });
});

describe('revoking', () => {
  it('records a revocation asked for in person with the user and the reason, beside an unchanged signature', async () => {
    const world = await publishedTemplate();
    const { requestId, patientId } = await signedConsent(world);
    const before = await storedSignature(patientId, requestId);

    const response = await h.api.post(
      `/consents/requests/${requestId}/revoke`,
      h.sessions.reception,
      {
        reason: 'La paciente cambió de opinión',
      },
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<ConsentRequestDto>()).toMatchObject({ status: 'revoked' });
    expect(response.json<ConsentRequestDto>().revokedAt).not.toBeNull();
    const after = await storedSignature(patientId, requestId);
    expect(after.content_fingerprint).toBe(before.content_fingerprint);
    expect(after.payload_enc.equals(before.payload_enc)).toBe(true);
    const revocation = await asTenant(runtime, h.tenant.id, (tx) =>
      tx.execute<{ channel: string; actor_user_id: string; reason_enc: Buffer }>(
        sql`SELECT channel, actor_user_id, reason_enc FROM consent_revocation WHERE request_id = ${requestId}`,
      ),
    );
    expect(revocation.rows[0]).toMatchObject({
      channel: 'in_person',
      actor_user_id: h.sessions.reception.user.id,
    });
    expect(revocation.rows[0]?.reason_enc.toString('latin1')).not.toContain('cambió');
    const audit = await auditRows('consent.revoked', requestId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toMatchObject({ channel: 'in_person', withReason: true });
    expect(JSON.stringify(audit[0]?.metadata)).not.toContain('cambió');
    const detail = (
      await h.api.get(`/consents/requests/${requestId}`, h.sessions.professional)
    ).json<SignedConsentDto>();
    expect(detail.request.status).toBe('revoked');
    expect(detail.revocation).toMatchObject({
      channel: 'in_person',
      reason: 'La paciente cambió de opinión',
    });
    expect(detail.fingerprintValid).toBe(true);
  });

  it('shows state revoked with the date in the list, for every role', async () => {
    const world = await publishedTemplate();
    const { requestId, patientId } = await signedConsent(world);
    await h.api.post(`/consents/requests/${requestId}/revoke`, h.sessions.professional, {});

    for (const session of [h.sessions.professional, h.sessions.reception, h.sessions.admin]) {
      const [entry] = (
        await h.api.get(`/patients/${patientId}/consents`, session)
      ).json<ConsentListResponse>().consents;
      expect(entry).toMatchObject({ id: requestId, status: 'revoked' });
      expect(entry?.revokedAt).not.toBeNull();
    }
  });

  it('revokes only what was signed, and only once', async () => {
    const world = await publishedTemplate();
    const pending = await requestOk(await newPatient(), world.templateId);
    const { requestId } = await signedConsent(world);

    const onPending = await h.api.post(
      `/consents/requests/${pending.id}/revoke`,
      h.sessions.reception,
      {},
    );
    expect(onPending.statusCode).toBe(409);
    expect(onPending.json<{ code: string }>().code).toBe('consent_not_signed');

    expect(
      (await h.api.post(`/consents/requests/${requestId}/revoke`, h.sessions.reception, {}))
        .statusCode,
    ).toBe(200);
    const again = await h.api.post(
      `/consents/requests/${requestId}/revoke`,
      h.sessions.reception,
      {},
    );
    expect(again.statusCode).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('consent_already_revoked');
    expect((await auditRows('consent.revoked', requestId)).length).toBe(1);
  });

  it('is denied to the administration, which neither requests nor records', async () => {
    const world = await publishedTemplate();
    const { requestId } = await signedConsent(world);

    expect(
      (await h.api.post(`/consents/requests/${requestId}/revoke`, h.sessions.admin, {})).statusCode,
    ).toBe(403);
  });

  it('keeps the signed consents of a template that is retired', async () => {
    const world = await publishedTemplate();
    const { requestId, patientId } = await signedConsent(world);

    const retire = await h.api.post(
      `/consent/templates/${world.templateId}/retire`,
      h.sessions.admin,
    );

    expect(retire.statusCode).toBe(200);
    const [entry] = (
      await h.api.get(`/patients/${patientId}/consents`, h.sessions.professional)
    ).json<ConsentListResponse>().consents;
    expect(entry).toMatchObject({ id: requestId, status: 'signed', canOpen: true });
    expect(
      (await h.api.get(`/consents/requests/${requestId}`, h.sessions.professional)).statusCode,
    ).toBe(200);
  });
});

describe('an organization that is read-only', () => {
  async function setStatus(status: 'active' | 'read_only') {
    await asTenant(runtime, h.tenant.id, (tx) =>
      tx
        .update(tenantTable)
        .set(
          status === 'read_only'
            ? { status, readOnlySince: new Date() }
            : { status, readOnlySince: null },
        )
        .where(eq(tenantTable.id, h.tenant.id)),
    );
  }

  it('accepts a revocation and reads, and refuses new templates, requests and signatures', async () => {
    const world = await publishedTemplate();
    const { requestId, patientId } = await signedConsent(world);
    const pending = await requestOk(await newPatient(), world.templateId);
    await setStatus('read_only');
    try {
      const revoke = await h.api.post(
        `/consents/requests/${requestId}/revoke`,
        h.sessions.reception,
        {
          reason: 'Retira el consentimiento',
        },
      );
      expect(revoke.statusCode, revoke.body).toBe(200);
      expect(revoke.json<ConsentRequestDto>().status).toBe('revoked');

      expect(
        (await h.api.get(`/patients/${patientId}/consents`, h.sessions.professional)).statusCode,
      ).toBe(200);
      expect(
        (await h.api.get(`/consents/requests/${requestId}`, h.sessions.professional)).statusCode,
      ).toBe(200);
      expect(
        (await h.api.get(`/consents/requests/${requestId}/document`, h.sessions.professional))
          .statusCode,
      ).toBe(200);

      const template = await h.api.post('/consent/templates', h.sessions.admin, draftBody());
      const newRequest = await request(await newPatient(), world.templateId);
      const signature = await sign(pending.id, signBody(pending.versionId));
      for (const refused of [template, newRequest, signature]) {
        expect(refused.statusCode).toBe(402);
        expect(refused.json<{ code: string }>().code).toBe('tenant_read_only');
      }
    } finally {
      await setStatus('active');
    }
  });

  function draftBody() {
    return { title: 'Nueva plantilla', body: 'Texto.' };
  }
});

describe('the warning on appointments that need a consent', () => {
  async function appointmentFor(patientId: string, appointmentTypeId?: string) {
    return asTenant(runtime, h.tenant.id, (tx) =>
      insertAppointmentRow(tx, h.tenant.id, {
        patient_id: patientId,
        ...(appointmentTypeId === undefined ? {} : { appointment_type_id: appointmentTypeId }),
      }),
    );
  }

  async function appointmentType(): Promise<string> {
    return asTenant(runtime, h.tenant.id, async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`INSERT INTO appointment_type (tenant_id, name, duration_minutes)
              VALUES (${h.tenant.id}, ${`Extraccion ${randomUUID().slice(0, 6)}`}, 30) RETURNING id`,
      );
      return rows.rows[0]?.id ?? '';
    });
  }

  const status = async (appointmentId: string, session = h.sessions.professional) => {
    const response = await h.api.get(`/appointments/${appointmentId}/consent-status`, session);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<AppointmentConsentStatusDto>();
  };

  it('warns when the consent is missing, clears it when signed, and warns again once revoked', async () => {
    const world = await publishedTemplate();
    const typeId = await appointmentType();
    const set = await h.api.put(`/consent/appointment-types/${typeId}`, h.sessions.admin, {
      templateId: world.templateId,
    });
    expect(set.statusCode, set.body).toBe(200);
    const patientId = await newPatient();
    const appointmentId = await appointmentFor(patientId, typeId);

    expect(await status(appointmentId)).toEqual({
      appointmentId,
      state: 'missing',
      templateId: world.templateId,
    });

    const created = await requestOk(patientId, world.templateId);
    expect((await status(appointmentId)).state).toBe('missing');
    await sign(created.id, signBody(created.versionId));
    expect((await status(appointmentId, h.sessions.reception)).state).toBe('valid');

    await h.api.post(`/consents/requests/${created.id}/revoke`, h.sessions.reception, {});
    expect((await status(appointmentId)).state).toBe('revoked');
  });

  it('says nothing is required for a type that requires no consent, and never names a title', async () => {
    const patientId = await newPatient();
    const appointmentId = await appointmentFor(patientId);

    const response = await h.api.get(
      `/appointments/${appointmentId}/consent-status`,
      h.sessions.reception,
    );

    expect(response.json<AppointmentConsentStatusDto>()).toEqual({
      appointmentId,
      state: 'not_required',
      templateId: null,
    });
    expect(
      (await h.api.get(`/appointments/${randomUUID()}/consent-status`, h.sessions.reception))
        .statusCode,
    ).toBe(404);
  });

  it('sets and clears the requirement of a type, only with a live template of the organization', async () => {
    const world = await publishedTemplate();
    const retired = await publishedTemplate();
    await h.api.post(`/consent/templates/${retired.templateId}/retire`, h.sessions.admin);
    const typeId = await appointmentType();
    const put = (templateId: string | null, session = h.sessions.admin, id = typeId) =>
      h.api.put(`/consent/appointment-types/${id}`, session, { templateId });

    expect((await put(world.templateId)).statusCode).toBe(200);
    expect((await put(randomUUID())).statusCode).toBe(404);
    expect((await put(retired.templateId)).statusCode).toBe(409);
    expect((await put(world.templateId, h.sessions.reception)).statusCode).toBe(403);
    expect((await put(world.templateId, h.sessions.admin, randomUUID())).statusCode).toBe(404);
    const listed = await h.api.get('/consent/appointment-types', h.sessions.admin);
    expect(
      listed
        .json<ConsentRequirementsResponse>()
        .requirements.find((entry) => entry.appointmentTypeId === typeId),
    ).toMatchObject({ templateId: world.templateId });

    expect((await put(null)).statusCode).toBe(200);
    expect(
      (await h.api.get('/consent/appointment-types', h.sessions.admin))
        .json<ConsentRequirementsResponse>()
        .requirements.find((entry) => entry.appointmentTypeId === typeId)?.templateId,
    ).toBeNull();
  });
});

describe('the portal entry points', () => {
  const portal = createConsentPortal({ keys });
  const identityId = randomUUID();
  const actor = () => ({
    kind: 'portal' as const,
    tenantId: h.tenant.id,
    identityId,
    linkId: randomUUID(),
  });
  const auditActor = {
    userId: null,
    actingRole: 'patient' as const,
    ip: '203.0.113.9',
    userAgent: 'portal-browser',
    requestId: 'req-portal',
  };

  it('lists the patient their own consents with the title, and no other patient', async () => {
    const world = await publishedTemplate({ title: 'Anestesia local' });
    const mine = await newPatient();
    const theirs = await newPatient();
    await requestOk(mine, world.templateId, { method: 'portal' });
    await requestOk(theirs, world.templateId, { method: 'portal' });

    const list = await asTenant(runtime, h.tenant.id, (tx) =>
      portal.list(tx, { actor: actor(), patientId: mine }),
    );

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'pending', title: 'Anestesia local', canOpen: false });
  });

  it('shows the text, signs as the portal identity, and leaves the evidence of the portal', async () => {
    const world = await publishedTemplate();
    const patientId = await newPatient();
    const created = await requestOk(patientId, world.templateId, { method: 'portal' });

    const signed = await asTenant(runtime, h.tenant.id, async (tx) => {
      const view = await portal.signingView(tx, {
        actor: actor(),
        patientId,
        requestId: created.id,
      });
      expect(view.version.body).toBe(BODY_ONE);
      return portal.sign(tx, {
        actor: actor(),
        auditActor,
        patientId,
        requestId: created.id,
        request: {
          versionId: view.version.id,
          accepted: true,
          signer: 'patient',
          mark: { kind: 'typed', name: 'Ana Pérez' },
        },
      });
    });

    expect(signed.status).toBe('signed');
    const stored = await storedSignature(patientId, created.id);
    expect(stored).toMatchObject({
      method: 'portal',
      recorded_by: null,
      portal_identity_id: identityId,
    });
    const rows = await auditRows('consent.signed', created.id);
    expect(rows[0]).toMatchObject({ actingRole: 'patient', actorUserId: null });
    expect(rows[0]?.metadata).toMatchObject({ method: 'portal', identityId });
    const detail = (
      await h.api.get(`/consents/requests/${created.id}`, h.sessions.professional)
    ).json<SignedConsentDto>();
    expect(detail.evidence).toMatchObject({ ip: '203.0.113.9', userAgent: 'portal-browser' });
    expect(detail.fingerprintValid).toBe(true);
  });

  it('answers "not found" for the request of another patient, and for one made to be signed in person', async () => {
    const world = await publishedTemplate();
    const mine = await newPatient();
    const theirs = await newPatient();
    const theirRequest = await requestOk(theirs, world.templateId, { method: 'portal' });
    const inPerson = await requestOk(mine, world.templateId);

    const attempt = (requestId: string) =>
      asTenant(runtime, h.tenant.id, (tx) =>
        portal.sign(tx, {
          actor: actor(),
          auditActor,
          patientId: mine,
          requestId,
          request: {
            versionId: theirRequest.versionId,
            accepted: true,
            signer: 'patient',
            mark: { kind: 'typed', name: 'Ana Pérez' },
          },
        }),
      );

    await expect(attempt(theirRequest.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(attempt(inPerson.id)).rejects.toMatchObject({ code: 'consent_method_mismatch' });
    expect((await auditRows('consent.signed', theirRequest.id)).length).toBe(0);
  });

  it('revokes in a read-only organization, and refuses what a portal actor may not do', async () => {
    const world = await publishedTemplate();
    const patientId = await newPatient();
    const created = await requestOk(patientId, world.templateId, { method: 'portal' });
    await asTenant(runtime, h.tenant.id, (tx) =>
      portal.sign(tx, {
        actor: actor(),
        auditActor,
        patientId,
        requestId: created.id,
        request: {
          versionId: created.versionId,
          accepted: true,
          signer: 'patient',
          mark: { kind: 'typed', name: 'Ana Pérez' },
        },
      }),
    );
    await asTenant(runtime, h.tenant.id, (tx) =>
      tx
        .update(tenantTable)
        .set({ status: 'read_only', readOnlySince: new Date() })
        .where(eq(tenantTable.id, h.tenant.id)),
    );
    try {
      const revoked = await asTenant(runtime, h.tenant.id, (tx) =>
        portal.revoke(tx, {
          actor: actor(),
          auditActor,
          patientId,
          requestId: created.id,
          request: { reason: 'Ya no lo autorizo' },
        }),
      );
      expect(revoked.status).toBe('revoked');
      const rows = await auditRows('consent.revoked', created.id);
      expect(rows[0]?.metadata).toMatchObject({ channel: 'portal', identityId });

      const elsewhere = { ...actor(), tenantId: randomUUID() };
      await expect(
        asTenant(runtime, h.tenant.id, (tx) => portal.list(tx, { actor: elsewhere, patientId })),
      ).rejects.toThrow();
    } finally {
      await asTenant(runtime, h.tenant.id, (tx) =>
        tx
          .update(tenantTable)
          .set({ status: 'active', readOnlySince: null })
          .where(eq(tenantTable.id, h.tenant.id)),
      );
    }
  });

  it('renders the printable record of what the patient signed, audited, and no other patient', async () => {
    const world = await publishedTemplate();
    const patientId = await newPatient();
    const other = await newPatient();
    const created = await requestOk(patientId, world.templateId, { method: 'portal' });
    await asTenant(runtime, h.tenant.id, (tx) =>
      portal.sign(tx, {
        actor: actor(),
        auditActor,
        patientId,
        requestId: created.id,
        request: {
          versionId: created.versionId,
          accepted: true,
          signer: 'patient',
          mark: { kind: 'drawn', imageDataUrl: DRAWN },
        },
      }),
    );

    const document = await asTenant(runtime, h.tenant.id, (tx) =>
      portal.document(tx, { actor: actor(), auditActor, patientId, requestId: created.id }),
    );

    expect(document.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(document.fileName).toBe(`consentimiento-${created.id}.pdf`);
    const reads = await auditRows('consent.read', created.id);
    expect(reads[0]?.metadata).toMatchObject({ via: 'portal' });
    await expect(
      asTenant(runtime, h.tenant.id, (tx) =>
        portal.document(tx, {
          actor: actor(),
          auditActor,
          patientId: other,
          requestId: created.id,
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    // The portal reads the signature of its subject only: nothing leaks through a plain transaction.
    const plain = await asTenant(runtime, h.tenant.id, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM consent_signature`),
    );
    expect(plain.rows[0]?.n).toBe(0);
  });
});

describe('the export', () => {
  it('hands each professional the signed consents of their own patients, with the text and the signature', async () => {
    const world = await publishedTemplate({ title: 'Consentimiento de exportación' });
    const mine = await signedConsent(world);
    const theirs = await newPatient({ treated: false });
    const strangers = await requestOk(theirs, world.templateId);
    await sign(strangers.id, signBody(strangers.versionId));
    await h.api.post(`/consents/requests/${mine.requestId}/revoke`, h.sessions.reception, {
      reason: 'Motivo privado',
    });

    const part = (await createWithTenant(runtime.db)(
      {
        tenantId: h.tenant.id,
        userId: h.sessions.professional.user.id,
        actingProfessionalId: h.professionalId,
      },
      (tx) =>
        exportSignedConsents(keys)({ tx, tenantId: h.tenant.id, professionalId: h.professionalId }),
    )) as {
      consents: {
        requestId: string;
        version: { body: string };
        revocation: { reason: string } | null;
        fingerprintValid: boolean;
      }[];
    };

    const ids = part.consents.map((entry) => entry.requestId);
    expect(ids).toContain(mine.requestId);
    expect(ids).not.toContain(strangers.id);
    const entry = part.consents.find((item) => item.requestId === mine.requestId);
    expect(entry?.version.body).toBe(BODY_ONE);
    expect(entry?.revocation?.reason).toBe('Motivo privado');
    expect(entry?.fingerprintValid).toBe(true);
  });

  it('hands the owner the templates and the requests as dates and states, never what was signed', async () => {
    const world = await publishedTemplate({ title: 'Plantilla para el dueño' });
    const { requestId } = await signedConsent(world);

    const part = (await createWithTenant(runtime.db)(
      { tenantId: h.tenant.id, userId: SYSTEM_USER_ID },
      (tx) => exportConsentTemplates({ tx, tenantId: h.tenant.id }),
    )) as {
      templates: { id: string; title: string; versions: { body: string }[] }[];
      requests: { id: string; status: string }[];
    };

    expect(part.templates.find((template) => template.id === world.templateId)).toMatchObject({
      title: 'Plantilla para el dueño',
      versions: [{ body: BODY_ONE }],
    });
    expect(part.requests.find((entry) => entry.id === requestId)?.status).toBe('signed');
    const text = JSON.stringify(part.requests);
    for (const secret of ['Ana Pérez', 'vitest-browser', 'payload', 'mark', 'evidence']) {
      expect(text, secret).not.toContain(secret);
    }
  });
});
