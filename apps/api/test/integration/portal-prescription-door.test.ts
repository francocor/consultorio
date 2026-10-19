import { randomUUID } from 'node:crypto';

import type {
  PortalDownloadLinkResponse,
  PortalPrescriptionsResponse,
  PrescriptionDto,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFakePrescriptionProvider } from '../../src/adapters/erx-fake/index.js';
import { careAssignment } from '../../src/db/schema/care.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { SYSTEM_USER_ID, createWithTenant, type Tx } from '../../src/platform/db/tenant-context.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';
import { AMOXICILLIN } from '../support/erx-world.js';
import { createPortalWorld, type PortalWorld } from '../support/portal-world.js';

/**
 * JD-S5 R1, S5-1 and S5-2: the portal's door to prescriptions.
 *
 * S5-1: the portal reads prescriptions on the connection of its own request. Before, the list, the
 * download link and the file door each opened a SECOND connection while holding the first, so ten
 * concurrent requests on a pool of ten left every connection waiting for an eleventh.
 *
 * S5-2: the portal runs as the nil user of the database (a patient has no user), which the clinical
 * policies of `prescription` treat as the system. The portal now marks its transactions, the
 * policies stop treating such a transaction as the system, and the portal reads through functions
 * bound to the link and the identity of its session.
 */
let runtime: DbHandle;
let world: PortalWorld;
let admin: pg.Client;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createPortalWorld(runtime, {
    slug: 'portal-rx-door',
    erx: createFakePrescriptionProvider(),
  });
  admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
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

async function issuedTo(patientId: string): Promise<PrescriptionDto> {
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

/** What a portal request is to the database: the nil user, the portal marker and the session's link. */
function asPortal<T>(
  bound: { linkId?: string; identityId?: string; marker?: boolean },
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  return createWithTenant(runtime.db)(
    { tenantId: world.tenant.id, userId: SYSTEM_USER_ID },
    async (tx) => {
      if (bound.marker !== false)
        await tx.execute(sql`select set_config('app.actor_kind', 'portal', true)`);
      if (bound.linkId) {
        await tx.execute(sql`select set_config('app.portal_link_id', ${bound.linkId}, true)`);
      }
      if (bound.identityId) {
        await tx.execute(
          sql`select set_config('app.portal_identity_id', ${bound.identityId}, true)`,
        );
      }
      return work(tx);
    },
  );
}

describe('S5-1: the portal never holds one connection while it waits for another', () => {
  it('serves twelve concurrent prescription lists, download links and downloads on a pool of ten', async () => {
    const patient = await portalPatient();
    const made = await issuedTo(patient.patientId);

    const lists = await Promise.all(
      Array.from({ length: 12 }, () => patient.visitor.get('/portal/prescriptions')),
    );
    for (const response of lists) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<PortalPrescriptionsResponse>().prescriptions).toHaveLength(1);
    }

    const links = await Promise.all(
      Array.from({ length: 12 }, () =>
        patient.visitor.post(`/portal/prescriptions/${made.id}/download-link`, {}),
      ),
    );
    for (const response of links) expect(response.statusCode, response.body).toBe(200);

    const files = await Promise.all(
      links.map((link) => patient.visitor.get(link.json<PortalDownloadLinkResponse>().url)),
    );
    for (const response of files) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    }
  }, 60_000);
});

describe('S5-2: the portal is not the system for the clinical policies of prescription', () => {
  it('reads no row of the table, not even the ones of its own patient', async () => {
    const patient = await portalPatient();
    await issuedTo(patient.patientId);
    const link = patient.identity.links[0];
    if (!link) throw new Error('no link');

    // The control: the nil user without the marker (a job) does read the table.
    const asJob = await asPortal({ marker: false }, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from prescription`),
    );
    expect(asJob.rows[0]?.n).toBeGreaterThan(0);

    // The portal, with its own link bound and no filter at all, reads nothing from the table.
    const asSession = await asPortal({ linkId: link.id, identityId: patient.identity.id }, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from prescription`),
    );
    expect(asSession.rows[0]?.n).toBe(0);
  });

  it('cannot change or create a prescription', async () => {
    const patient = await portalPatient();
    const made = await issuedTo(patient.patientId);
    const link = patient.identity.links[0];
    if (!link) throw new Error('no link');

    const updated = await asPortal({ linkId: link.id, identityId: patient.identity.id }, (tx) =>
      tx.execute(
        sql`update prescription set document_key = 'x' where id = ${made.id} returning id`,
      ),
    );
    expect(updated.rows).toHaveLength(0);
    await expect(
      asPortal({ linkId: link.id, identityId: patient.identity.id }, (tx) =>
        tx.execute(sql`update prescription set status = 'cancelled' where id = ${made.id}`),
      ),
    ).resolves.toBeDefined();
    // Read as the system (a job), which does see the table.
    const row = await asPortal({ marker: false }, (tx) =>
      tx.execute<{ status: string; document_key: string | null }>(
        sql`select status, document_key from prescription where id = ${made.id}`,
      ),
    );
    // The row is still what the professional left (no policy let the portal touch it).
    expect(row.rows[0]?.status).toBe('issued');
    expect(row.rows[0]?.document_key).not.toBe('x');
  });

  it('lists through the function only the prescriptions of the patient of its own link, with no filter', async () => {
    const mine = await portalPatient();
    const theirs = await portalPatient();
    const ofMine = await issuedTo(mine.patientId);
    const ofTheirs = await issuedTo(theirs.patientId);
    const link = mine.identity.links[0];
    if (!link) throw new Error('no link');

    const rows = await asPortal({ linkId: link.id, identityId: mine.identity.id }, (tx) =>
      tx.execute<{ id: string; patient_id: string }>(
        sql`select id, patient_id from app.portal_prescriptions()`,
      ),
    );

    expect(rows.rows.map((row) => row.id)).toEqual([ofMine.id]);
    expect(rows.rows.map((row) => row.id)).not.toContain(ofTheirs.id);
    // Asking for the other patient's by id answers nothing either.
    const single = await asPortal({ linkId: link.id, identityId: mine.identity.id }, (tx) =>
      tx.execute(sql`select id from app.portal_prescription(${ofTheirs.id}::uuid)`),
    );
    expect(single.rows).toHaveLength(0);
    const own = await asPortal({ linkId: link.id, identityId: mine.identity.id }, (tx) =>
      tx.execute(sql`select id from app.portal_prescription(${ofMine.id}::uuid)`),
    );
    expect(own.rows).toHaveLength(1);
  });

  it('opens nothing with a forged setting: the link must be live and belong to the identity', async () => {
    const mine = await portalPatient();
    const theirs = await portalPatient();
    await issuedTo(mine.patientId);
    const ofTheirs = await issuedTo(theirs.patientId);
    const myLink = mine.identity.links[0];
    const theirLink = theirs.identity.links[0];
    if (!myLink || !theirLink) throw new Error('no link');
    const list = (tx: Tx) => tx.execute(sql`select id from app.portal_prescriptions()`);

    // Nothing bound.
    expect((await asPortal({}, list)).rows).toHaveLength(0);
    // The link of one account with the identity of another.
    expect(
      (await asPortal({ linkId: theirLink.id, identityId: mine.identity.id }, list)).rows,
    ).toHaveLength(0);
    // A link that does not exist.
    expect(
      (await asPortal({ linkId: randomUUID(), identityId: mine.identity.id }, list)).rows,
    ).toHaveLength(0);
    // A link that ended.
    const ended = await world.api.post(`/portal-links/${theirLink.id}/revoke`, world.reception, {});
    expect(ended.statusCode, ended.body).toBe(200);
    expect(
      (await asPortal({ linkId: theirLink.id, identityId: theirs.identity.id }, list)).rows,
    ).toHaveLength(0);
    expect(
      (
        await asPortal({ linkId: theirLink.id, identityId: theirs.identity.id }, (tx) =>
          tx.execute(sql`select id from app.portal_prescription(${ofTheirs.id}::uuid)`),
        )
      ).rows,
    ).toHaveLength(0);
  });
});
