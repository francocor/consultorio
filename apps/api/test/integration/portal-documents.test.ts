import type { PortalDocumentsResponse } from '@consultorio/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createPortalWorld, rowsOf, type PortalWorld } from '../support/portal-world.js';

/**
 * The documents the staff share with a patient (S5.08, task 5.32): the patient sees what was
 * shared with them and nothing else, a clinical document is shared only by a professional who can
 * open it, and the portal reads them through the functions of the database that answer only for
 * the link of the request.
 */
let runtime: DbHandle;
let world: PortalWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createPortalWorld(runtime, { slug: 'portal-documents' });
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

const share = (documentId: string, by = world.reception) =>
  world.api.post(`/documents/${documentId}/portal-share`, by, {});
const unshare = (documentId: string, by = world.reception) =>
  world.api.delete(`/documents/${documentId}/portal-share`, by);

describe('what the patient sees', () => {
  it('lists nothing that nobody shared, and the document once it is shared', async () => {
    const { visitor, patientId } = await world.patientSession();
    const document = await world.documentFor(patientId, {
      name: 'cobertura.pdf',
      category: 'coverage_card',
    });

    const before = await visitor.get('/portal/documents');
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json<PortalDocumentsResponse>().documents).toEqual([]);

    const shared = await share(document.id);
    expect(shared.statusCode, shared.body).toBe(200);
    expect(shared.json()).toMatchObject({ shared: true });
    const after = (await visitor.get('/portal/documents')).json<PortalDocumentsResponse>();

    expect(after.documents).toHaveLength(1);
    expect(after.documents[0]).toMatchObject({
      id: document.id,
      name: 'cobertura.pdf',
      category: 'coverage_card',
      contentType: 'application/pdf',
      sizeBytes: document.bytes.length,
    });
    // The storage key and the hash never reach the patient's list.
    expect(JSON.stringify(after)).not.toContain('t/');
    expect(JSON.stringify(after)).not.toContain('objectKey');
  });

  it('shows a patient only what is shared with them, not what is shared with somebody else', async () => {
    const mine = await world.patientSession();
    const theirs = await world.patientSession();
    const mineDocument = await world.documentFor(mine.patientId, { name: 'mio.pdf' });
    const theirDocument = await world.documentFor(theirs.patientId, { name: 'ajeno.pdf' });
    await share(mineDocument.id);
    await share(theirDocument.id);

    const listed = (await mine.visitor.get('/portal/documents')).json<PortalDocumentsResponse>();

    expect(listed.documents.map((document) => document.name)).toEqual(['mio.pdf']);
  });

  it('does not offer a document that is hidden, and refuses to share one still in quarantine', async () => {
    const { visitor, patientId } = await world.patientSession();
    const hidden = await world.documentFor(patientId, { name: 'oculto.pdf' });
    const visible = await world.documentFor(patientId, { name: 'visible.pdf' });
    await share(hidden.id);
    await share(visible.id);
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE document SET status = 'hidden', hidden_at = now(), hidden_by = ${crypto.randomUUID()}, hidden_reason = 'subido por error' WHERE id = ${hidden.id}`,
      ),
    );

    const listed = (await visitor.get('/portal/documents')).json<PortalDocumentsResponse>();
    expect(listed.documents.map((entry) => entry.name)).toEqual(['visible.pdf']);

    const quarantined = await world.documentFor(patientId, { status: 'quarantined' });
    expect((await share(quarantined.id)).statusCode).toBe(409);
  });

  it('is written in the trail when the patient looks at the list', async () => {
    const { visitor, patientId } = await world.patientSession();
    await visitor.get('/portal/documents');

    const rows = (await audits('portal.read')).filter((row) => row.patientId === patientId);

    expect(rows.at(-1)).toMatchObject({ actingRole: 'patient', resourceType: 'document' });
    expect(rows.at(-1)?.metadata).toMatchObject({ section: 'documents', count: 0 });
  });
});

describe('who may share', () => {
  it('lets a professional share a clinical document they can open, and the patient sees it', async () => {
    const { visitor, patientId } = await world.patientSession();
    const document = await world.documentFor(patientId, {
      clinical: true,
      name: 'laboratorio.pdf',
    });

    const shared = await share(document.id, world.doctor);

    expect(shared.statusCode, shared.body).toBe(200);
    const listed = (await visitor.get('/portal/documents')).json<PortalDocumentsResponse>();
    expect(listed.documents.map((entry) => [entry.name, entry.category])).toEqual([
      ['laboratorio.pdf', 'lab_result'],
    ]);
  });

  it('refuses the administration, reception and another professional a clinical document, and audits it', async () => {
    const { patientId } = await world.patientSession();
    const document = await world.documentFor(patientId, { clinical: true });
    const before = (await audits('access.denied')).length;

    const answers = await Promise.all(
      [world.admin, world.owner, world.reception, world.colleague].map((by) =>
        share(document.id, by),
      ),
    );

    expect(answers.map((answer) => answer.statusCode)).toEqual([403, 403, 403, 403]);
    const denied = (await audits('access.denied')).slice(before);
    expect(denied.length).toBeGreaterThanOrEqual(4);
    // The document is invisible to them, so the entry can name it but not its patient.
    expect(denied.filter((row) => row.resourceId === document.id).length).toBeGreaterThanOrEqual(4);
    const status = await world.api.get(`/documents/${document.id}/portal-share`, world.doctor);
    expect(status.json()).toMatchObject({ shared: false });
  });

  it('lets reception and the administration share an administrative document and refuses a professional', async () => {
    const { patientId } = await world.patientSession();
    const first = await world.documentFor(patientId);
    const second = await world.documentFor(patientId);
    const third = await world.documentFor(patientId);

    expect((await share(first.id, world.admin)).statusCode).toBe(200);
    expect((await share(second.id, world.reception)).statusCode).toBe(200);

    expect((await share(third.id, world.doctor)).statusCode).toBe(403);
  });

  it('answers 404 for a document that does not exist', async () => {
    const response = await share('0190a000-0000-7000-8000-00000000dead');

    expect(response.statusCode).toBe(404);
  });
});

describe('sharing and unsharing', () => {
  it('stops showing a document when it is unshared, and can share it again', async () => {
    const { visitor, patientId } = await world.patientSession();
    const document = await world.documentFor(patientId);
    await share(document.id);

    const stopped = await unshare(document.id);
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(stopped.json()).toEqual({ shared: false, sharedAt: null });
    const emptied = (await visitor.get('/portal/documents')).json<PortalDocumentsResponse>();
    expect(emptied.documents).toEqual([]);
    await share(document.id);
    const again = (await visitor.get('/portal/documents')).json<PortalDocumentsResponse>();
    expect(again.documents).toHaveLength(1);
    // Two shares in the history of the document, one live.
    const rows = await rowsOf<{ live: number; total: number }>(
      world,
      sql`SELECT count(*) FILTER (WHERE unshared_at IS NULL)::int AS live, count(*)::int AS total
            FROM document_share WHERE document_id = ${document.id}`,
    );
    expect(rows[0]).toEqual({ live: 1, total: 2 });
  });

  it('tells the patient by email that something is waiting, without saying what, and only once', async () => {
    const { patientId, email } = await world.patientSession();
    const document = await world.documentFor(patientId, { name: 'resultado-secreto.pdf' });
    world.email.clear();

    await share(document.id);
    await share(document.id);

    const notices = world.email.sent.filter((mail) => mail.to === email);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.subject).toContain('documento');
    expect(notices[0]?.text).not.toContain('resultado-secreto');
    expect(notices[0]?.text).toContain('/portal');
  });

  it('is written in the trail with the document and the patient but without its name', async () => {
    const { patientId } = await world.patientSession();
    const document = await world.documentFor(patientId, { name: 'nombre-visible.pdf' });
    await share(document.id);

    const rows = (await audits('sharing.changed')).filter((row) => row.resourceId === document.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ patientId, outcome: 'allow', resourceType: 'document' });
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain('nombre-visible');
  });
});

describe('the functions of the database', () => {
  it('answer nothing to a query that does not come through the subject of a session', async () => {
    const { patientId } = await world.patientSession();
    const document = await world.documentFor(patientId);
    await share(document.id);

    // Straight to the function, as any other code of the application would: no link, no rows.
    const bare = await rowsOf<{ id: string }>(
      world,
      sql`SELECT id FROM app.portal_shared_documents()`,
    );
    expect(bare).toEqual([]);
    const other = await world.patientSession();
    const link = other.identity.links[0]?.id ?? '';
    // With the identity and link of somebody else: the patient's documents are not theirs.
    const crossed = await world.inTenant(async (tx) => {
      await tx.execute(
        sql`select set_config('app.portal_link_id', ${link}, true),
                   set_config('app.portal_identity_id', ${other.identity.id}, true)`,
      );
      return tx.execute(sql`SELECT id FROM app.portal_shared_documents()`);
    });
    expect(crossed.rows).toEqual([]);
    // With a link and an identity that do not belong together: nothing either.
    const mismatched = await world.inTenant(async (tx) => {
      await tx.execute(
        sql`select set_config('app.portal_link_id', ${link}, true),
                   set_config('app.portal_identity_id', ${crypto.randomUUID()}, true)`,
      );
      return tx.execute(sql`SELECT id FROM app.portal_shared_documents()`);
    });
    expect(mismatched.rows).toEqual([]);
  });

  it('give the document of the link of the request, and only that', async () => {
    const mine = await world.patientSession();
    const document = await world.documentFor(mine.patientId, { name: 'mio.pdf' });
    await share(document.id);

    const answered = await world.inTenant(async (tx) => {
      await tx.execute(
        sql`select set_config('app.portal_link_id', ${mine.identity.links[0]?.id ?? ''}, true),
                   set_config('app.portal_identity_id', ${mine.identity.id}, true)`,
      );
      const one = await tx.execute(
        sql`SELECT object_key, original_name FROM app.portal_shared_document(${document.id}::uuid)`,
      );
      const none = await tx.execute(
        sql`SELECT object_key FROM app.portal_shared_document(${crypto.randomUUID()}::uuid)`,
      );
      return { one: one.rows, none: none.rows };
    });

    expect(answered.one).toEqual([{ object_key: document.objectKey, original_name: 'mio.pdf' }]);
    expect(answered.none).toEqual([]);
  });
});

describe('a read-only organization', () => {
  it('blocks the sharing of the staff and stays open to the patient', async () => {
    const { visitor, patientId } = await world.patientSession();
    const document = await world.documentFor(patientId);
    await share(document.id);
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE tenant SET status = 'read_only', read_only_since = now() WHERE id = ${world.tenant.id}`,
      ),
    );
    try {
      const other = await world.documentFor(patientId);
      expect((await share(other.id)).statusCode).toBe(402);
      expect((await unshare(document.id)).statusCode).toBe(402);
      const status = await world.api.get(`/documents/${document.id}/portal-share`, world.reception);
      expect(status.statusCode).toBe(200);
      expect((await visitor.get('/portal/documents')).statusCode).toBe(200);
    } finally {
      await world.inTenant((tx) =>
        tx.execute(
          sql`UPDATE tenant SET status = 'active', read_only_since = NULL WHERE id = ${world.tenant.id}`,
        ),
      );
    }
  });
});
