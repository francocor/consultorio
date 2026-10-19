import type { DownloadLinkResponse, PortalDownloadLinkResponse } from '@consultorio/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { hashActionToken } from '../../src/platform/tokens/index.js';
import {
  createFakePortalConsents,
  createFakePortalPrescriptions,
  type FakePortalConsents,
  type FakePortalPrescriptions,
} from '../support/portal-fakes.js';
import { createPortalWorld, type PortalWorld } from '../support/portal-world.js';

/**
 * Downloads for the patient (S5.09, task 5.35): a link per file, bound to the session that asked
 * for it, five minutes, one use, authorized again when it is used, and every download audited.
 */
let runtime: DbHandle;
let world: PortalWorld;
let consents: FakePortalConsents;
let prescriptions: FakePortalPrescriptions;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  consents = createFakePortalConsents();
  prescriptions = createFakePortalPrescriptions();
  world = await createPortalWorld(runtime, {
    slug: 'portal-downloads',
    ports: { consent: consents, prescriptions },
  });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const audits = (action: string) =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, action as never)))
      .orderBy(asc(auditEvent.occurredAt)),
  );

const share = (documentId: string) =>
  world.api.post(`/documents/${documentId}/portal-share`, world.reception, {});

/** A patient with a document shared with them, and the link to it. */
async function sharedDocument(options: { name?: string; bytes?: Buffer } = {}) {
  const session = await world.patientSession();
  const document = await world.documentFor(session.patientId, options);
  expect((await share(document.id)).statusCode).toBe(200);
  const link = await session.visitor.post(`/portal/documents/${document.id}/download-link`, {});
  expect(link.statusCode, link.body).toBe(200);
  return { ...session, document, link: link.json<PortalDownloadLinkResponse>() };
}

describe('a link to a shared document', () => {
  it('is an address of the portal, never of the storage, and serves the file as an attachment once', async () => {
    const { visitor, document, link } = await sharedDocument({ name: 'resultado.pdf' });

    expect(link.url).toMatch(/^\/portal\/files\/[A-Za-z0-9_-]{43}$/);
    expect(link.url).not.toContain('t/');
    const response = await visitor.get(link.url);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.rawPayload.equals(document.bytes)).toBe(true);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toContain(
      'attachment; filename="resultado.pdf"',
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain('sandbox');
    // Spent: the second time it is no use.
    expect((await visitor.get(link.url)).statusCode).toBe(403);
  });

  it('writes the download in the trail with the patient and the document, and no name', async () => {
    const { visitor, patientId, document, link } = await sharedDocument({ name: 'privado.pdf' });
    await visitor.get(link.url);

    const rows = (await audits('portal.download')).filter((row) => row.resourceId === document.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'allow',
      actingRole: 'patient',
      actorUserId: null,
      patientId,
      resourceType: 'document',
    });
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain('privado');
  });

  it('expires after five minutes', async () => {
    const { visitor, link } = await sharedDocument();
    const clocked = await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE action_token SET expires_at = ${world.now().toISOString()}::timestamptz - interval '1 second'
              WHERE kind = 'document_download' AND token_hash = ${hashActionToken(link.url.split('/').pop() ?? '')}`,
      ),
    );
    expect(clocked.rowCount).toBe(1);

    expect((await visitor.get(link.url)).statusCode).toBe(403);
  });

  it('does not work from another session of the same patient, from another patient or from nobody', async () => {
    const { visitor, email, patientId, link } = await sharedDocument();
    const second = await world.signInAs(email);
    const stranger = await world.patientSession();

    expect((await second.get(link.url)).statusCode).toBe(403);
    expect((await stranger.visitor.get(link.url)).statusCode).toBe(403);
    expect((await world.visitor().get(link.url)).statusCode).toBe(401);
    // None of those attempts spent it: the session it was issued to can still use it.
    expect((await visitor.get(link.url)).statusCode).toBe(200);
    expect(patientId).toBeTruthy();
  });

  it('does not work at the door of the staff, and a link of the staff does not work at the door of the portal', async () => {
    const { visitor, document, link } = await sharedDocument();
    const token = link.url.split('/').pop() ?? '';

    // The staff door reads the staff cookie: reception with the patient\'s token finds nothing.
    const atStaffDoor = await world.api.get(`/files/${token}`, world.reception);
    expect(atStaffDoor.statusCode).toBe(403);
    // A link that a member of the staff asked for the same file opens nothing for the patient.
    const staffLink = await world.api.post(
      `/documents/${document.id}/download-link`,
      world.reception,
    );
    expect(staffLink.statusCode, staffLink.body).toBe(200);
    const staffToken = staffLink.json<DownloadLinkResponse>().url.split('/').pop() ?? '';
    expect((await visitor.get(`/portal/files/${staffToken}`)).statusCode).toBe(403);
    // And the patient's own link was not spent by either attempt.
    expect((await visitor.get(link.url)).statusCode).toBe(200);
  });

  it('is refused when the sharing ended inside the five minutes, and audited', async () => {
    const { visitor, patientId, document, link } = await sharedDocument();
    await world.api.delete(`/documents/${document.id}/portal-share`, world.reception);
    const before = (await audits('portal.denied')).length;

    const response = await visitor.get(link.url);

    expect(response.statusCode).toBe(403);
    const rows = (await audits('portal.denied')).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resourceType: 'document',
      resourceId: document.id,
      patientId,
      reason: 'portal_download_not_available',
    });
    expect((await audits('portal.download')).some((row) => row.resourceId === document.id)).toBe(
      false,
    );
  });

  it('is refused when the access of the person ended meanwhile: their sessions end with it', async () => {
    const { visitor, identity, link } = await sharedDocument();
    await world.api.post(`/portal-identities/${identity.id}/deactivate`, world.admin, {});

    expect((await visitor.get(link.url)).statusCode).toBe(401);
  });

  it('is refused when the person switched to another record: the file belongs to the first one', async () => {
    const parentEmail = `padres-${crypto.randomUUID().slice(0, 6)}@example.test`;
    const first = await world.patientWith({ birthDate: '2020-09-14', email: null });
    const second = await world.patientWith({ birthDate: '2022-01-02', email: null });
    const note = 'Verificado en persona con la partida de nacimiento.';
    const invited = await world.inviteOk(first, {
      email: parentEmail,
      relation: 'mother',
      verificationNote: note,
    });
    await world.activate(world.activationPathSentTo(parentEmail));
    await world.api.post(`/portal-identities/${invited.id}/links`, world.reception, {
      patientId: second,
      relation: 'mother',
      verificationNote: note,
    });
    const visitor = await world.signInAs(parentEmail);
    const me = (await visitor.get('/portal/me')).json<{
      links: { id: string; patientId: string }[];
    }>();
    const firstLink = me.links.find((link) => link.patientId === first);
    const secondLink = me.links.find((link) => link.patientId === second);
    await visitor.post('/portal/subject', { linkId: firstLink?.id });
    const document = await world.documentFor(first);
    await share(document.id);
    const link = (
      await visitor.post(`/portal/documents/${document.id}/download-link`, {})
    ).json<PortalDownloadLinkResponse>();

    await visitor.post('/portal/subject', { linkId: secondLink?.id });
    const wrong = await visitor.get(link.url);
    await visitor.post('/portal/subject', { linkId: firstLink?.id });
    const right = await visitor.get(link.url);

    // The refusal does not spend it: back on the right record the same link works.
    expect(wrong.statusCode).toBe(403);
    expect(right.statusCode).toBe(200);
  });

  it("is not given for a document that is not the patient's or is not shared, and the attempt is audited", async () => {
    const mine = await world.patientSession();
    const theirs = await world.patientSession();
    const mineUnshared = await world.documentFor(mine.patientId);
    const theirShared = await world.documentFor(theirs.patientId);
    await share(theirShared.id);
    const before = (await audits('portal.denied')).length;

    const unshared = await mine.visitor.post(
      `/portal/documents/${mineUnshared.id}/download-link`,
      {},
    );
    const foreign = await mine.visitor.post(
      `/portal/documents/${theirShared.id}/download-link`,
      {},
    );

    expect(unshared.statusCode).toBe(404);
    expect(foreign.statusCode).toBe(404);
    expect((await audits('portal.denied')).length).toBe(before + 2);
  });

  it('serves a name with quotes and line breaks as a harmless header', async () => {
    const { visitor, link } = await sharedDocument({
      name: 'a"b; filename="x.exe\r\nX-Evil: 1.pdf',
    });

    const response = await visitor.get(link.url);

    expect(response.statusCode).toBe(200);
    const header = String(response.headers['content-disposition']);
    expect(header).not.toMatch(/[\r\n]/);
    expect(response.headers['x-evil']).toBeUndefined();
    expect(header.startsWith('attachment; filename="')).toBe(true);
  });
});

describe('links to what other modules own', () => {
  it('serves a signed consent and a prescription through their modules, bound the same way', async () => {
    const { visitor, patientId } = await world.patientSession();
    const consentBytes = Buffer.from('%PDF consentimiento firmado');
    const prescriptionBytes = Buffer.from('%PDF receta');
    await world.storage.put(world.tenant.id, `t/${world.tenant.id}/signed/consent.pdf`, {
      body: consentBytes,
      contentType: 'application/pdf',
      contentLength: consentBytes.length,
    });
    await world.storage.put(world.tenant.id, `t/${world.tenant.id}/rx/receta.pdf`, {
      body: prescriptionBytes,
      contentType: 'application/pdf',
      contentLength: prescriptionBytes.length,
    });
    const consentId = consents.seed(patientId, {
      status: 'signed',
      file: {
        objectKey: `t/${world.tenant.id}/signed/consent.pdf`,
        fileName: 'consentimiento.pdf',
        contentType: 'application/pdf',
      },
    });
    const prescriptionId = prescriptions.seed(patientId, {
      file: {
        objectKey: `t/${world.tenant.id}/rx/receta.pdf`,
        fileName: 'receta.pdf',
        contentType: 'application/pdf',
      },
    });

    const consentLink = await visitor.post(`/portal/consents/${consentId}/download-link`, {});
    const prescriptionLink = await visitor.post(
      `/portal/prescriptions/${prescriptionId}/download-link`,
      {},
    );
    expect(consentLink.statusCode, consentLink.body).toBe(200);
    expect(prescriptionLink.statusCode, prescriptionLink.body).toBe(200);
    const consentFile = await visitor.get(consentLink.json<PortalDownloadLinkResponse>().url);
    const prescriptionFile = await visitor.get(
      prescriptionLink.json<PortalDownloadLinkResponse>().url,
    );

    expect(consentFile.rawPayload.equals(consentBytes)).toBe(true);
    expect(prescriptionFile.rawPayload.equals(prescriptionBytes)).toBe(true);
    expect(prescriptionFile.headers['content-disposition']).toContain('filename="receta.pdf"');
    const rows = (await audits('portal.download')).filter((row) => row.patientId === patientId);
    expect(rows.map((row) => row.resourceType).sort()).toEqual(['consent', 'prescription']);
  });

  it("is not given for what the module does not hand out: not the patient's, or no file", async () => {
    const mine = await world.patientSession();
    const theirs = await world.patientSession();
    const foreign = prescriptions.seed(theirs.patientId, {
      file: {
        objectKey: `t/${world.tenant.id}/rx/x.pdf`,
        fileName: 'x.pdf',
        contentType: 'application/pdf',
      },
    });
    const without = prescriptions.seed(mine.patientId);

    expect(
      (await mine.visitor.post(`/portal/prescriptions/${foreign}/download-link`, {})).statusCode,
    ).toBe(404);
    expect(
      (await mine.visitor.post(`/portal/prescriptions/${without}/download-link`, {})).statusCode,
    ).toBe(404);
  });

  it('is not given for a module that is not wired', async () => {
    const plain = await createPortalWorld(runtime, { slug: 'portal-downloads-plain' });
    try {
      const { visitor } = await plain.patientSession();

      const response = await visitor.post(
        '/portal/prescriptions/0190a000-0000-7000-8000-00000000dead/download-link',
        {},
      );

      expect(response.statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });
});

describe('a read-only organization', () => {
  it('lets the patient download what they have: a link is a read', async () => {
    const { visitor, link } = await sharedDocument();
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE tenant SET status = 'read_only', read_only_since = now() WHERE id = ${world.tenant.id}`,
      ),
    );
    try {
      const again = await visitor.post(
        `/portal/documents/${crypto.randomUUID()}/download-link`,
        {},
      );
      const file = await visitor.get(link.url);

      expect(again.statusCode).toBe(404);
      expect(file.statusCode).toBe(200);
    } finally {
      await world.inTenant((tx) =>
        tx.execute(
          sql`UPDATE tenant SET status = 'active', read_only_since = NULL WHERE id = ${world.tenant.id}`,
        ),
      );
    }
  });
});
