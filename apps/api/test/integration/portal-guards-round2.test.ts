import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { SYSTEM_USER_ID, createWithTenant, type Tx } from '../../src/platform/db/tenant-context.js';
import { createPortalWorld, type PortalWorld } from '../support/portal-world.js';

/**
 * JD-S5 R2-5: the `document` table let the nil user through. The portal acts as the nil user (the
 * patient has no user of its own), and an administrative document is visible to every transaction of
 * the organization, so a transaction of the portal could `select * from document`. It marks itself
 * (`app.actor_kind = 'portal'`) and sees no row of the table; the documents shared with the patient
 * reach it only through the definer functions bound to its link.
 */
let runtime: DbHandle;
let world: PortalWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createPortalWorld(runtime, { slug: 'portal-guards-round2', ports: {} });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

/** What a request of the portal is to the database: the nil user and the marker of the portal. */
function asPortal<T>(work: (tx: Tx) => Promise<T>, options: { marker?: boolean } = {}): Promise<T> {
  return createWithTenant(runtime.db)(
    { tenantId: world.tenant.id, userId: SYSTEM_USER_ID },
    async (tx) => {
      if (options.marker !== false) {
        await tx.execute(sql`select set_config('app.actor_kind', 'portal', true)`);
      }
      return work(tx);
    },
  );
}

const countDocuments = (tx: Tx) =>
  tx.execute<{ n: number }>(sql`select count(*)::int as n from document`);

describe('R2-5: the portal reads no row of the document table', () => {
  it('sees neither the administrative nor the clinical documents of its own patient or of anybody', async () => {
    const mine = await world.patientSession();
    const other = await world.patientWith();
    await world.documentFor(mine.patientId, { clinical: false });
    await world.documentFor(mine.patientId, { clinical: true });
    await world.documentFor(other, { clinical: false });

    // The control: the nil user without the marker (a job, the scan) does read the table.
    const asJob = await asPortal(countDocuments, { marker: false });
    expect(asJob.rows[0]?.n).toBeGreaterThanOrEqual(3);

    const asSession = await asPortal(countDocuments);
    expect(asSession.rows[0]?.n).toBe(0);
  });

  it('cannot change a document either', async () => {
    const mine = await world.patientSession();
    const document = await world.documentFor(mine.patientId, { clinical: false });

    const touched = await asPortal((tx) =>
      tx.execute(
        sql`update document set original_name = 'x.pdf' where id = ${document.id} returning id`,
      ),
    );

    expect(touched.rows).toHaveLength(0);
  });

  it('still reads a document shared with the patient, through the function bound to the link', async () => {
    const mine = await world.patientSession();
    const document = await world.documentFor(mine.patientId, { clinical: false });
    const shared = await world.api.post(
      `/documents/${document.id}/portal-share`,
      world.reception,
      {},
    );
    expect(shared.statusCode, shared.body).toBe(200);

    const listed = await mine.visitor.get('/portal/documents');

    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<{ documents: { id: string }[] }>().documents.map((d) => d.id)).toContain(
      document.id,
    );
  });
});
