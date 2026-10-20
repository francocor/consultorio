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
import { uuidv7 } from '../../src/platform/db/uuid.js';
import { AMOXICILLIN } from '../support/erx-world.js';
import { createPortalWorld, type PortalWorld } from '../support/portal-world.js';

/**
 * JD-S5 R2, the prescriptions in the portal:
 *
 * - B-S5: the list of the portal is paged with a cursor, so a patient with more than a hundred
 *   prescriptions reaches every one of them;
 * - B-S7: a link to a prescription whose PDF has not been stored is issued only if the PDF can be
 *   made, so the link (single use) is not spent on a download that cannot happen.
 */
let runtime: DbHandle;
let world: PortalWorld;
let admin: pg.Client;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createPortalWorld(runtime, {
    slug: 'portal-rx-round2',
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

describe('B-S5: the prescriptions of the portal are paged', () => {
  it('reaches every prescription of a patient who has more than a hundred, newest first, each once', async () => {
    const patient = await portalPatient();
    const template = await issuedTo(patient.patientId);
    // 104 more, written straight to the table (the guard of the trigger is for requests): 105 in all.
    await admin.query(
      `BEGIN;
       set local session_replication_role = replica;
       insert into prescription (tenant_id, patient_id, author_professional_id, client_key, status,
                                 content_enc, prescription_date, idempotency_key, external_id,
                                 issued_at, simulated, document_key)
       select tenant_id, patient_id, author_professional_id, gen_random_uuid(), 'issued', content_enc,
              prescription_date, 'bulk-' || g || '-' || gen_random_uuid(),
              'RXBULK-' || g || '-' || substr(gen_random_uuid()::text, 1, 8),
              now() - (g || ' minutes')::interval, simulated, document_key
         from prescription, generate_series(1, 104) g
        where id = '${template.id}';
       COMMIT;`,
    );

    const first = await patient.visitor.get('/portal/prescriptions');
    expect(first.statusCode, first.body).toBe(200);
    const page1 = first.json<PortalPrescriptionsResponse>();
    expect(page1.prescriptions).toHaveLength(100);
    expect(page1.nextCursor).toEqual(expect.any(String));

    const second = await patient.visitor.get(
      `/portal/prescriptions?cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
    );
    expect(second.statusCode, second.body).toBe(200);
    const page2 = second.json<PortalPrescriptionsResponse>();
    expect(page2.prescriptions).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();

    const ids = [...page1.prescriptions, ...page2.prescriptions].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(105);
    const issuedAt = [...page1.prescriptions, ...page2.prescriptions].map((entry) =>
      new Date(entry.issuedAt ?? 0).getTime(),
    );
    expect(issuedAt).toEqual([...issuedAt].sort((a, b) => b - a));
  }, 120_000);

  it('answers a short list with no cursor, and refuses a cursor that is not one', async () => {
    const patient = await portalPatient();
    await issuedTo(patient.patientId);

    const listed = await patient.visitor.get('/portal/prescriptions');
    expect(listed.json<PortalPrescriptionsResponse>().nextCursor).toBeNull();

    for (const cursor of [
      'x',
      'not-base64!',
      'e30',
      Buffer.from('{"a":1}').toString('base64url'),
    ]) {
      const refused = await patient.visitor.get(
        `/portal/prescriptions?cursor=${encodeURIComponent(cursor)}`,
      );
      expect(refused.statusCode, `${cursor}: ${refused.body}`).toBe(400);
    }
  });

  it('refuses a cursor whose date cannot exist, instead of failing in the database (JD-S5 R3)', async () => {
    const patient = await portalPatient();
    await issuedTo(patient.patientId);

    for (const at of [
      '2026-13-01T10:00:00.000Z',
      '2026-02-30T10:00:00.000Z',
      '2026-10-19T25:00:00.000Z',
      '2026-10-19T10:61:00.000Z',
    ]) {
      const cursor = Buffer.from(
        JSON.stringify({ at, id: 'ffffffff-ffff-7fff-bfff-ffffffffffff' }),
      ).toString('base64url');
      const refused = await patient.visitor.get(`/portal/prescriptions?cursor=${cursor}`);
      expect(refused.statusCode, `${at}: ${refused.body}`).toBe(400);
    }
  });

  it('pages across prescriptions issued within the same millisecond (JD-S5 R3)', async () => {
    const patient = await portalPatient();
    const template = await issuedTo(patient.patientId);
    // 104 more issued microseconds apart: one millisecond tells none of them from the next.
    await admin.query(
      `BEGIN;
       set local session_replication_role = replica;
       insert into prescription (tenant_id, patient_id, author_professional_id, client_key, status,
                                 content_enc, prescription_date, idempotency_key, external_id,
                                 issued_at, simulated, document_key)
       select tenant_id, patient_id, author_professional_id, gen_random_uuid(), 'issued', content_enc,
              prescription_date, 'micro-' || g || '-' || gen_random_uuid(),
              'RXMICRO-' || g || '-' || substr(gen_random_uuid()::text, 1, 8),
              date_trunc('milliseconds', now()) + interval '1 hour' + (g || ' microseconds')::interval,
              simulated, document_key
         from prescription, generate_series(1, 104) g
        where id = '${template.id}';
       COMMIT;`,
    );

    const first = await patient.visitor.get('/portal/prescriptions');
    const page1 = first.json<PortalPrescriptionsResponse>();
    const second = await patient.visitor.get(
      `/portal/prescriptions?cursor=${encodeURIComponent(page1.nextCursor ?? '')}`,
    );
    const page2 = second.json<PortalPrescriptionsResponse>();

    const ids = [...page1.prescriptions, ...page2.prescriptions].map((entry) => entry.id);
    expect(ids).toHaveLength(105);
    expect(new Set(ids).size).toBe(105);
    expect(page2.nextCursor).toBeNull();
  }, 120_000);

  it('never lets the cursor reach the prescriptions of somebody else', async () => {
    const mine = await portalPatient();
    const theirs = await portalPatient();
    await issuedTo(mine.patientId);
    const ofTheirs = await issuedTo(theirs.patientId);

    // A cursor in the far future covers everything: the function still answers for the link only.
    const cursor = Buffer.from(
      JSON.stringify({
        at: '2999-01-01T00:00:00.000Z',
        id: 'ffffffff-ffff-7fff-bfff-ffffffffffff',
      }),
    ).toString('base64url');
    const page = await mine.visitor.get(`/portal/prescriptions?cursor=${cursor}`);

    expect(page.statusCode, page.body).toBe(200);
    expect(
      page.json<PortalPrescriptionsResponse>().prescriptions.map((entry) => entry.id),
    ).not.toContain(ofTheirs.id);
  });
});

describe('B-S7: a link is issued only for a document that can be made', () => {
  async function withoutStoredDocument(patientId: string) {
    const made = await issuedTo(patientId);
    await admin.query(
      `BEGIN;
       set local session_replication_role = replica;
       update prescription set document_key = null where id = '${made.id}';
       COMMIT;`,
    );
    return made;
  }

  it('renders the document for a prescription that has none stored, and the link works', async () => {
    const patient = await portalPatient();
    const made = await withoutStoredDocument(patient.patientId);

    const link = await patient.visitor.post(`/portal/prescriptions/${made.id}/download-link`, {});
    expect(link.statusCode, link.body).toBe(200);
    const file = await patient.visitor.get(link.json<PortalDownloadLinkResponse>().url);

    expect(file.statusCode, file.body).toBe(200);
    expect(file.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('issues no link, and spends no token, when the document cannot be made', async () => {
    const patient = await portalPatient();
    const made = await withoutStoredDocument(patient.patientId);
    // The stored content cannot be opened any more (it does not decrypt).
    await admin.query(
      `BEGIN;
       set local session_replication_role = replica;
       update prescription set content_enc = '\\x0102030405'::bytea where id = '${made.id}';
       COMMIT;`,
    );
    const tokens = () =>
      world.inTenant((tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from action_token where kind = 'document_download' and subject_id = ${made.id}`,
        ),
      );
    const before = (await tokens()).rows[0]?.n ?? 0;

    const link = await patient.visitor.post(`/portal/prescriptions/${made.id}/download-link`, {});

    expect(link.statusCode, link.body).toBe(404);
    expect((await tokens()).rows[0]?.n).toBe(before);
  });
});
