import type {
  AuditAction,
  ConsentStartersResponse,
  ConsentTemplateDetailResponse,
  ConsentTemplateDto,
  ConsentTemplateListResponse,
  OfferedConsentTemplatesResponse,
} from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { templateFingerprint } from '../../src/modules/consent/domain/fingerprint.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { asSystem, createDocumentsHarness, type DocumentsHarness } from '../support/documents.js';
import { asTenant } from '../support/tenants.js';

/**
 * Consent templates (S5.02, tasks 5.9 and 5.11): authoring, publishing as numbered versions,
 * editing a published template, retiring, and who may do what (informed-consent, "Consent
 * template authoring" and "Template versioning").
 */
let runtime: DbHandle;
let h: DocumentsHarness;
let other: DocumentsHarness;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  h = await createDocumentsHarness(runtime, 'consent-templates');
  other = await createDocumentsHarness(runtime, 'consent-templates-b');
});

afterAll(async () => {
  await h.close();
  await other.close();
  await runtime.close();
});

const BODY = 'Autorizo la extracción.\nEntiendo los riesgos.';

let counter = 0;
const draftRequest = (overrides: Record<string, unknown> = {}) => {
  counter += 1;
  return { title: `Extracción dental ${String(counter)}`, body: BODY, ...overrides };
};

async function createDraft(
  session = h.sessions.admin,
  overrides: Record<string, unknown> = {},
): Promise<ConsentTemplateDto> {
  const response = await h.api.post('/consent/templates', session, draftRequest(overrides));
  expect(response.statusCode, response.body).toBe(201);
  return response.json<ConsentTemplateDto>();
}

async function publish(id: string, session = h.sessions.admin) {
  return h.api.post(`/consent/templates/${id}/publish`, session);
}

async function detail(id: string, session = h.sessions.admin) {
  const response = await h.api.get(`/consent/templates/${id}`, session);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<ConsentTemplateDetailResponse>();
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

describe('creating a template', () => {
  it('saves it as a draft with no version, and audits it without the text', async () => {
    const created = await createDraft(h.sessions.admin, { specialty: 'odontology' });

    expect(created).toMatchObject({
      status: 'draft',
      body: BODY,
      specialty: 'odontology',
      latestVersionNumber: null,
      versionCount: 0,
    });
    const rows = await auditRows('consent.template.created', created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'allow', resourceType: 'consent_template' });
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain('extracción');
  });

  it('lets the owner, an admin and a professional author templates', async () => {
    for (const session of [h.sessions.owner, h.sessions.admin, h.sessions.professional]) {
      const response = await h.api.post('/consent/templates', session, draftRequest());
      expect(response.statusCode).toBe(201);
    }
  });

  it('denies reception and records the denial, without creating anything', async () => {
    const request = draftRequest();
    const before = await asSystem(runtime, h.tenant.id, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM consent_template`),
    );

    const response = await h.api.post('/consent/templates', h.sessions.reception, request);

    expect(response.statusCode).toBe(403);
    const after = await asSystem(runtime, h.tenant.id, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM consent_template`),
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    const denials = await asSystem(runtime, h.tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.action, 'access.denied'), eq(auditEvent.outcome, 'deny'))),
    );
    expect(denials.some((row) => row.actorUserId === h.sessions.reception.user.id)).toBe(true);
  });

  it('refuses reception the library as well: listing and reading are for who authors', async () => {
    const created = await createDraft();

    expect((await h.api.get('/consent/templates', h.sessions.reception)).statusCode).toBe(403);
    expect(
      (await h.api.get(`/consent/templates/${created.id}`, h.sessions.reception)).statusCode,
    ).toBe(403);
  });

  it('rejects an empty title, a text that is too long and unknown fields', async () => {
    for (const body of [
      draftRequest({ title: '   ' }),
      draftRequest({ body: 'x'.repeat(20_001) }),
      draftRequest({ patientId: '0197c0a0-0000-7000-8000-000000000001' }),
    ]) {
      const response = await h.api.post('/consent/templates', h.sessions.admin, body);
      expect(response.statusCode).toBe(400);
    }
  });

  it('starts from a starter of the product, and refuses one that does not exist', async () => {
    const starters = (
      await h.api.get('/consent/starters', h.sessions.admin)
    ).json<ConsentStartersResponse>();
    const starter = starters.starters.find((entry) => entry.key === 'odontology_extraction');
    expect(starter).toBeDefined();
    expect(starters.starters.map((entry) => entry.specialty).sort()).toEqual([
      'general',
      'nutrition',
      'odontology',
      'physiotherapy',
      'psychology',
    ]);

    const created = await createDraft(h.sessions.admin, {
      title: starter?.title,
      body: starter?.body,
      specialty: starter?.specialty,
      starterKey: 'odontology_extraction',
    });
    expect(created.starterKey).toBe('odontology_extraction');

    const unknown = await h.api.post(
      '/consent/templates',
      h.sessions.admin,
      draftRequest({ starterKey: 'invented' }),
    );
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json<{ code: string }>().code).toBe('consent_starter_unknown');
  });

  it('refuses an appointment type that is not in the organization', async () => {
    const type = await asTenant(runtime, h.tenant.id, async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`INSERT INTO appointment_type (tenant_id, name, duration_minutes)
              VALUES (${h.tenant.id}, 'Extraccion', 30) RETURNING id`,
      );
      return rows.rows[0]?.id ?? '';
    });

    const known = await h.api.post(
      '/consent/templates',
      h.sessions.admin,
      draftRequest({ appointmentTypeId: type }),
    );
    expect(known.statusCode).toBe(201);
    expect(known.json<ConsentTemplateDto>().appointmentTypeId).toBe(type);

    const unknown = await h.api.post(
      '/consent/templates',
      h.sessions.admin,
      draftRequest({ appointmentTypeId: '0197c0a0-0000-7000-8000-0000000000aa' }),
    );
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json<{ code: string }>().code).toBe('consent_appointment_type_unknown');
  });
});

describe('publishing', () => {
  it('turns the draft into version 1, with the fingerprint of its title and text', async () => {
    const draft = await createDraft();

    const response = await publish(draft.id);

    expect(response.statusCode).toBe(200);
    const published = response.json<ConsentTemplateDetailResponse>();
    expect(published.template).toMatchObject({
      status: 'published',
      latestVersionNumber: 1,
      versionCount: 1,
    });
    expect(published.versions).toHaveLength(1);
    expect(published.versions[0]).toMatchObject({
      number: 1,
      title: draft.title,
      body: BODY,
      latest: true,
      contentHash: templateFingerprint({ title: draft.title, body: BODY }),
    });
    const rows = await auditRows('consent.template.published', draft.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({ version: 1 });
  });

  it('refuses to publish a template that is not a draft', async () => {
    const draft = await createDraft();
    await publish(draft.id);

    const again = await publish(draft.id);

    expect(again.statusCode).toBe(409);
    expect(again.json<{ code: string }>().code).toBe('consent_template_not_draft');
    expect((await detail(draft.id)).versions).toHaveLength(1);
  });

  it('is denied to reception', async () => {
    const draft = await createDraft();

    expect((await publish(draft.id, h.sessions.reception)).statusCode).toBe(403);
    expect((await detail(draft.id)).template.status).toBe('draft');
  });
});

describe('editing', () => {
  it('changes a draft in place and creates no version', async () => {
    const draft = await createDraft();

    const response = await h.api.patch(`/consent/templates/${draft.id}`, h.sessions.admin, {
      title: 'Título corregido',
      body: 'Texto corregido.',
    });

    expect(response.statusCode).toBe(200);
    const edited = response.json<ConsentTemplateDetailResponse>();
    expect(edited.template).toMatchObject({
      title: 'Título corregido',
      body: 'Texto corregido.',
      status: 'draft',
      versionCount: 0,
    });
    expect(edited.versions).toEqual([]);
  });

  it('creates version 2 when a published template is edited, and keeps version 1 as it was', async () => {
    const draft = await createDraft();
    await publish(draft.id);

    const response = await h.api.patch(`/consent/templates/${draft.id}`, h.sessions.professional, {
      body: 'Autorizo la extracción y el uso de anestesia local.',
    });

    expect(response.statusCode).toBe(200);
    const edited = response.json<ConsentTemplateDetailResponse>();
    expect(edited.template).toMatchObject({
      status: 'published',
      latestVersionNumber: 2,
      versionCount: 2,
    });
    expect(edited.versions.map((version) => [version.number, version.latest])).toEqual([
      [2, true],
      [1, false],
    ]);
    const first = edited.versions.find((version) => version.number === 1);
    expect(first).toMatchObject({
      title: draft.title,
      body: BODY,
      contentHash: templateFingerprint({ title: draft.title, body: BODY }),
    });
    const second = edited.versions.find((version) => version.number === 2);
    expect(second?.contentHash).toBe(
      templateFingerprint({
        title: draft.title,
        body: 'Autorizo la extracción y el uso de anestesia local.',
      }),
    );
    const rows = await auditRows('consent.template.published', draft.id);
    expect(rows.map((row) => (row.metadata as { version?: number }).version).sort()).toEqual([
      1, 2,
    ]);
  });

  it('creates no version for an edit that only differs in whitespace nobody reads', async () => {
    const draft = await createDraft();
    await publish(draft.id);

    const response = await h.api.patch(`/consent/templates/${draft.id}`, h.sessions.admin, {
      body: 'Autorizo la extracción.  \r\nEntiendo los riesgos.\r\n\r\n',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<ConsentTemplateDetailResponse>().template.versionCount).toBe(1);
  });

  it('changes the specialty of a published template without a new version', async () => {
    const draft = await createDraft();
    await publish(draft.id);

    const response = await h.api.patch(`/consent/templates/${draft.id}`, h.sessions.admin, {
      specialty: 'odontology',
    });

    const edited = response.json<ConsentTemplateDetailResponse>();
    expect(edited.template).toMatchObject({ specialty: 'odontology', versionCount: 1 });
  });

  it('serializes two edits at once: each one gets its own number', async () => {
    const draft = await createDraft();
    await publish(draft.id);

    const [first, second] = await Promise.all([
      h.api.patch(`/consent/templates/${draft.id}`, h.sessions.admin, { body: 'Texto A.' }),
      h.api.patch(`/consent/templates/${draft.id}`, h.sessions.owner, { body: 'Texto B.' }),
    ]);

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    const numbers = (await detail(draft.id)).versions.map((version) => version.number);
    expect(numbers).toEqual([3, 2, 1]);
  });

  it('is denied to reception', async () => {
    const draft = await createDraft();

    const response = await h.api.patch(`/consent/templates/${draft.id}`, h.sessions.reception, {
      body: 'x',
    });

    expect(response.statusCode).toBe(403);
  });

  it('answers as if it did not exist for a template of another organization', async () => {
    const theirs = await other.api.post('/consent/templates', other.sessions.admin, draftRequest());
    const id = theirs.json<ConsentTemplateDto>().id;

    expect((await h.api.get(`/consent/templates/${id}`, h.sessions.admin)).statusCode).toBe(404);
    expect(
      (await h.api.patch(`/consent/templates/${id}`, h.sessions.admin, { title: 'Otro' }))
        .statusCode,
    ).toBe(404);
  });
});

describe('retiring', () => {
  it('retires a published template: it keeps its versions and takes no more changes', async () => {
    const draft = await createDraft();
    await publish(draft.id);

    const response = await h.api.post(`/consent/templates/${draft.id}/retire`, h.sessions.admin);

    expect(response.statusCode).toBe(200);
    const retired = response.json<ConsentTemplateDetailResponse>();
    expect(retired.template.status).toBe('retired');
    expect(retired.template.retiredAt).not.toBeNull();
    expect(retired.versions).toHaveLength(1);
    expect((await auditRows('consent.template.retired', draft.id)).length).toBe(1);

    const edit = await h.api.patch(`/consent/templates/${draft.id}`, h.sessions.admin, {
      body: 'x',
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json<{ code: string }>().code).toBe('consent_template_retired');
    const again = await h.api.post(`/consent/templates/${draft.id}/retire`, h.sessions.admin);
    expect(again.statusCode).toBe(409);
    expect((await publish(draft.id)).statusCode).toBe(409);
  });

  it('retires a draft that was never published', async () => {
    const draft = await createDraft();

    const response = await h.api.post(`/consent/templates/${draft.id}/retire`, h.sessions.owner);

    expect(response.statusCode).toBe(200);
    expect(response.json<ConsentTemplateDetailResponse>().template.status).toBe('retired');
  });

  it('is denied to reception', async () => {
    const draft = await createDraft();

    expect(
      (await h.api.post(`/consent/templates/${draft.id}/retire`, h.sessions.reception)).statusCode,
    ).toBe(403);
  });
});

describe('what is offered for new signatures', () => {
  it('offers the latest published version of each live template, and nothing else', async () => {
    const live = await createDraft(h.sessions.admin, { specialty: 'general' });
    await publish(live.id);
    await h.api.patch(`/consent/templates/${live.id}`, h.sessions.admin, {
      body: 'Segunda versión.',
    });
    const draftOnly = await createDraft();
    const retired = await createDraft();
    await publish(retired.id);
    await h.api.post(`/consent/templates/${retired.id}/retire`, h.sessions.admin);

    const response = await h.api.get('/consent/offered-templates', h.sessions.reception);

    expect(response.statusCode).toBe(200);
    const offered = response.json<OfferedConsentTemplatesResponse>().templates;
    const mine = offered.filter((entry) => entry.templateId === live.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ versionNumber: 2, title: live.title, specialty: 'general' });
    expect(offered.some((entry) => entry.templateId === draftOnly.id)).toBe(false);
    expect(offered.some((entry) => entry.templateId === retired.id)).toBe(false);
  });

  it('is for who requests consents: professionals and reception, not the administration', async () => {
    expect(
      (await h.api.get('/consent/offered-templates', h.sessions.professional)).statusCode,
    ).toBe(200);
    expect((await h.api.get('/consent/offered-templates', h.sessions.admin)).statusCode).toBe(403);
  });

  it('lists the library for who authors, newest first', async () => {
    const response = await h.api.get('/consent/templates', h.sessions.professional);

    expect(response.statusCode).toBe(200);
    const templates = response.json<ConsentTemplateListResponse>().templates;
    expect(templates.length).toBeGreaterThan(3);
    const stamps = templates.map((entry) => entry.createdAt);
    expect([...stamps].sort().reverse()).toEqual(stamps);
  });
});
