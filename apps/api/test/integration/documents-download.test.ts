import { randomUUID } from 'node:crypto';

import type { AuditAction, DownloadLinkResponse } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { actionToken } from '../../src/db/schema/action-token.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { careAssignment } from '../../src/db/schema/care.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { minimalPdf } from '../../src/platform/files/test-files.js';
import { browserHeaders } from '../support/app.js';
import { withScanning, type ScanningHarness } from '../support/document-scans.js';
import { asSystem, createDocumentsHarness } from '../support/documents.js';
import { signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant } from '../support/tenants.js';

let runtime: DbHandle;
let h: ScanningHarness;
let other: ScanningHarness;
let now = new Date();

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  // The clock is shared by the application, so a test can move the five minutes of a link.
  h = withScanning(await createDocumentsHarness(runtime, 'docs-download', { clock: () => now }));
  other = withScanning(await createDocumentsHarness(runtime, 'docs-download-b'));
});

afterAll(async () => {
  await h.close();
  await other.close();
  await runtime.close();
});

const BYTES = minimalPdf('resultado de laboratorio');

/** An available clinical document of a patient the professional treats. */
async function availableDocument(
  options: {
    category?: 'lab_result' | 'id_copy';
    as?: TestSession;
    name?: string;
    bytes?: Buffer;
    patientId?: string;
  } = {},
) {
  const patientId = options.patientId ?? (await h.patient());
  const category = options.category ?? 'lab_result';
  const uploaded = await h.upload(
    options.as ?? (category === 'id_copy' ? h.sessions.reception : h.sessions.professional),
    {
      patientId,
      category,
      bytes: options.bytes ?? BYTES,
      ...(options.name === undefined ? {} : { name: options.name }),
    },
  );
  await h.runScans();
  return { id: uploaded.id, patientId };
}

const issue = (documentId: string, session: TestSession) =>
  h.api.post(`/documents/${documentId}/download-link`, session);

async function auditRows(action: AuditAction, patientId: string) {
  const rows = await asSystem(runtime, h.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, h.tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return rows.filter((row) => row.patientId === patientId);
}

/** The denial entries written for one document, newest first. */
async function denialsFor(documentId: string) {
  const rows = await asSystem(runtime, h.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, h.tenant.id), eq(auditEvent.action, 'access.denied')))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return rows.filter((row) => row.resourceId === documentId);
}

/** How many denials say this reason, whichever document (a spent or foreign link names none). */
async function denialsBecause(reason: string) {
  const rows = await asSystem(runtime, h.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, h.tenant.id), eq(auditEvent.action, 'access.denied'))),
  );
  return rows.filter((row) => row.reason === reason).length;
}

const tokenCount = async () =>
  (
    await asSystem(runtime, h.tenant.id, (tx) =>
      tx.select().from(actionToken).where(eq(actionToken.kind, 'document_download')),
    )
  ).length;

describe('an authorized download', () => {
  it('issues a link for this session, serves the file through the API, and audits the download', async () => {
    const { id, patientId } = await availableDocument({ name: 'Análisis de sangre.pdf' });

    const link = await issue(id, h.sessions.professional);
    expect(link.statusCode).toBe(200);
    const body = link.json<DownloadLinkResponse>();
    expect(body.url).toMatch(/^\/files\/[A-Za-z0-9_-]{43}$/);
    expect(new Date(body.expiresAt).getTime() - now.getTime()).toBeLessThanOrEqual(
      5 * 60_000 + 1000,
    );

    const file = await h.api.get(body.url, h.sessions.professional);

    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(BYTES)).toBe(true);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toBe(
      `attachment; filename="An_lisis_de_sangre.pdf"; filename*=UTF-8''An%C3%A1lisis%20de%20sangre.pdf`,
    );
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-length']).toBe(String(BYTES.length));
    const [event] = await auditRows('document.downloaded', patientId);
    expect(event).toMatchObject({
      outcome: 'allow',
      resourceType: 'document',
      resourceId: id,
      actorUserId: h.sessions.professional.user.id,
    });
    expect(JSON.stringify(event?.metadata)).not.toContain(body.url.slice('/files/'.length));
  });

  it('lets reception download an administrative document it can read', async () => {
    const { id } = await availableDocument({ category: 'id_copy' });

    const link = await issue(id, h.sessions.reception);
    const file = await h.api.get(link.json<DownloadLinkResponse>().url, h.sessions.reception);

    expect(link.statusCode).toBe(200);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(BYTES)).toBe(true);
  });

  it('still downloads in a read-only organization: issuing a link counts as a read', async () => {
    const { id } = await availableDocument();
    await asTenant(runtime, h.tenant.id, (tx) =>
      tx
        .update(tenantTable)
        .set({ status: 'read_only', readOnlySince: new Date() })
        .where(eq(tenantTable.id, h.tenant.id)),
    );
    try {
      const link = await issue(id, h.sessions.professional);
      const file = await h.api.get(link.json<DownloadLinkResponse>().url, h.sessions.professional);

      expect(link.statusCode).toBe(200);
      expect(file.statusCode).toBe(200);
    } finally {
      await asTenant(runtime, h.tenant.id, (tx) =>
        tx
          .update(tenantTable)
          .set({ status: 'active', readOnlySince: null })
          .where(eq(tenantTable.id, h.tenant.id)),
      );
    }
  });
});

describe('a link is not a bearer URL', () => {
  it('stops working after five minutes', async () => {
    const { id } = await availableDocument();
    // The clock of the application is this one: start from a fresh instant, then move it.
    const start = new Date();
    now = start;
    const { url } = (await issue(id, h.sessions.professional)).json<DownloadLinkResponse>();

    now = new Date(start.getTime() + 4 * 60_000);
    const early = await h.api.get(url, h.sessions.professional);
    expect(early.statusCode).toBe(200);

    const second = (await issue(id, h.sessions.professional)).json<DownloadLinkResponse>();
    now = new Date(start.getTime() + 10 * 60_000);
    const late = await h.api.get(second.url, h.sessions.professional);
    now = new Date();

    expect(late.statusCode).toBe(403);
  });

  it('works once: the same link a second time is refused', async () => {
    const { id } = await availableDocument();
    const { url } = (await issue(id, h.sessions.professional)).json<DownloadLinkResponse>();

    expect((await h.api.get(url, h.sessions.professional)).statusCode).toBe(200);
    expect((await h.api.get(url, h.sessions.professional)).statusCode).toBe(403);
  });

  it('is useless to another user, and to the same user in another session', async () => {
    const { id } = await availableDocument();
    const { url } = (await issue(id, h.sessions.professional)).json<DownloadLinkResponse>();
    const deniedBefore = await denialsBecause('file_link_invalid');
    const sameUserElsewhere = await signInAs(
      h.app,
      h.tenant.slug,
      h.sessions.professional.user,
      TEST_PASSWORD,
    );

    expect((await h.api.get(url, h.sessions.colleague)).statusCode).toBe(403);
    expect((await h.api.get(url, sameUserElsewhere)).statusCode).toBe(403);
    // And neither of those attempts spent the link: its owner can still use it.
    expect((await h.api.get(url, h.sessions.professional)).statusCode).toBe(200);
    expect(await denialsBecause('file_link_invalid')).toBe(deniedBefore + 2);
  });

  it('is not answered to HEAD, so a link checker cannot spend the one use of a link', async () => {
    const { id } = await availableDocument();
    const { url } = (await issue(id, h.sessions.professional)).json<DownloadLinkResponse>();

    const head = await h.app.inject({
      method: 'HEAD',
      url,
      headers: browserHeaders(h.tenant.slug, h.sessions.professional.cookie),
    });

    expect(head.statusCode).toBe(404);
    expect((await h.api.get(url, h.sessions.professional)).statusCode).toBe(200);
  });

  it('needs a session: pasted into a browser with none, it is refused', async () => {
    const { id } = await availableDocument();
    const { url } = (await issue(id, h.sessions.professional)).json<DownloadLinkResponse>();

    expect((await h.api.get(url, null)).statusCode).toBe(401);
  });

  it('refuses a link that was never issued, or is not a link at all, the same way', async () => {
    const made = await h.api.get(`/files/${'A'.repeat(43)}`, h.sessions.professional);
    const junk = await h.api.get('/files/not-a-token', h.sessions.professional);

    expect(made.statusCode).toBe(403);
    expect(junk.statusCode).toBe(403);
    expect(made.json()).toEqual({
      ...junk.json(),
      requestId: made.json<{ requestId: string }>().requestId,
    });
  });

  it('is checked again when it is used: access lost in those five minutes ends the download', async () => {
    const hidden = await availableDocument();
    // A patient both professionals treat; the colleague wrote the document, so the other
    // professional reads it only through the care relationship.
    const sharedPatient = await h.patient();
    await asTenant(runtime, h.tenant.id, (tx) =>
      tx.insert(careAssignment).values({
        tenantId: h.tenant.id,
        patientId: sharedPatient,
        professionalId: h.colleagueId,
        assignedBy: randomUUID(),
      }),
    );
    const unassigned = await availableDocument({
      patientId: sharedPatient,
      as: h.sessions.colleague,
    });
    const hiddenLink = (
      await issue(hidden.id, h.sessions.professional)
    ).json<DownloadLinkResponse>();
    const unassignedLink = (
      await issue(unassigned.id, h.sessions.professional)
    ).json<DownloadLinkResponse>();

    // One document is hidden, and the professional stops treating the other patient, inside the window.
    expect(
      (
        await h.api.post(`/documents/${hidden.id}/hide`, h.sessions.professional, {
          reason: 'Paciente equivocado',
        })
      ).statusCode,
    ).toBe(200);
    await asTenant(runtime, h.tenant.id, (tx) =>
      tx
        .update(careAssignment)
        .set({ removedAt: new Date(), removedBy: h.sessions.owner.user.id })
        .where(
          and(
            eq(careAssignment.patientId, sharedPatient),
            eq(careAssignment.professionalId, h.professionalId),
          ),
        ),
    );

    expect((await h.api.get(hiddenLink.url, h.sessions.professional)).statusCode).toBe(403);
    expect((await h.api.get(unassignedLink.url, h.sessions.professional)).statusCode).toBe(403);
    expect((await denialsFor(unassigned.id)).length).toBe(1);
    expect((await denialsFor(hidden.id)).length).toBe(1);
  });
});

describe('who gets a link', () => {
  it('refuses reception and the administration a clinical document: no link is issued and the attempt is audited', async () => {
    const { id } = await availableDocument();
    const before = await tokenCount();

    for (const session of [h.sessions.reception, h.sessions.admin, h.sessions.owner]) {
      expect((await issue(id, session)).statusCode).toBe(403);
    }

    expect(await tokenCount()).toBe(before);
    expect((await denialsFor(id)).length).toBe(3);
  });

  it('refuses a professional with no relationship to the patient', async () => {
    const { id } = await availableDocument();

    expect((await issue(id, h.sessions.colleague)).statusCode).toBe(403);
  });

  it('answers not found for a document that does not exist or belongs to another organization', async () => {
    const foreign = await other.patient();
    const uploaded = await other.upload(other.sessions.professional, {
      patientId: foreign,
      category: 'lab_result',
      bytes: BYTES,
    });
    await other.runScans();

    expect((await issue(uploaded.id, h.sessions.professional)).statusCode).toBe(404);
    expect(
      (await issue('0190a000-0000-7000-8000-00000000dead', h.sessions.professional)).statusCode,
    ).toBe(404);
  });

  it('issues nothing for a document still waiting for its scan, or one that was rejected', async () => {
    h.scanner.setAvailable(false);
    const patientId = await h.patient();
    const waiting = await h.upload(h.sessions.professional, {
      patientId,
      category: 'lab_result',
      bytes: BYTES,
    });
    await h.runScans();
    const before = await tokenCount();

    // Still quarantined: the scanner is down, so nothing has been released.
    expect((await issue(waiting.id, h.sessions.professional)).statusCode).toBe(409);

    h.scanner.setAvailable(true);
    const rejected = await h.upload(h.sessions.professional, {
      patientId,
      category: 'lab_result',
      bytes: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]),
    });
    await h.runScans();
    expect((await issue(rejected.id, h.sessions.professional)).statusCode).toBe(409);
    expect(await tokenCount()).toBe(before);
  });
});
