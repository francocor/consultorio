import { randomUUID } from 'node:crypto';

import type { PortalIdentityDto, Problem } from '@consultorio/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createPortalWorld, type PortalWorld } from '../support/portal-world.js';

/**
 * JD-S5 R2-2: staff cannot reach the clinical record of an adult through the portal by editing the
 * two facts the portal trusts. Reception can change the birth date of a patient (to make them a
 * minor) and the e-mail of the record (to its own). The rule decided by the owner ("an
 * administrator never reads clinical data"):
 *
 * 1. whenever the e-mail or the birth date of a record changes, the PREVIOUS record e-mail is told,
 *    with no link, through an outbox written in the same transaction as the change;
 * 2. for seven days after such a change, an invitation (to the patient or to a representative), a
 *    representative link and a registration need an owner or an administrator;
 * 3. the e-mail change of an account (owner or administrator) is told to the old address through
 *    the outbox too, not after the commit;
 * 4. a representative for a minor whose record has no e-mail needs an owner or an administrator;
 * and all of it is in the trail.
 */
const SLUG = 'portal-record-change';
let runtime: DbHandle;
let world: PortalWorld;
let admin: pg.Client;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createPortalWorld(runtime, { slug: SLUG, ports: {} });
  admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
});

afterAll(async () => {
  await admin.end();
  await world.close();
  await runtime.close();
});

const NOTE = 'Presentó su DNI y la partida de nacimiento.';
const address = (prefix: string) => `${prefix}-${randomUUID().slice(0, 6)}@example.test`;
const problemOf = (response: LightMyRequestResponse) => response.json<Problem>();

const auditsOf = (action: string) =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, action as never))),
  );

const patch = (patientId: string, body: Record<string, unknown>) =>
  world.api.patch(`/patients/${patientId}`, world.reception, body);

const changesOf = (patientId: string) =>
  world.inTenant((tx) =>
    tx.execute<{
      email_changed: boolean;
      birth_date_changed: boolean;
      notice_email: string | null;
      notice_sent_at: string | null;
    }>(
      sql`select email_changed, birth_date_changed, notice_email, notice_sent_at
            from patient_record_change where patient_id = ${patientId} order by created_at`,
    ),
  );

/** Ages the changes of a patient, the way a week going by does (the trail of the table is immutable). */
async function ageChanges(patientId: string, days: number): Promise<void> {
  await admin.query(
    `BEGIN;
     set local session_replication_role = replica;
     update patient_record_change set created_at = created_at - interval '${String(days)} days'
      where patient_id = '${patientId}';
     COMMIT;`,
  );
}

describe('R2-2 (1): the previous address of the record is told, through the outbox', () => {
  it('writes the change in the transaction of the update, and tells the address the record had, with no link', async () => {
    const before = address('antes');
    const after = address('despues');
    const patient = await world.patientWith({ birthDate: '1985-03-10', email: before });

    const response = await patch(patient, { email: after });
    expect(response.statusCode, response.body).toBe(200);

    // Written with the update, whoever made it.
    const changes = await changesOf(patient);
    expect(changes.rows).toEqual([
      {
        email_changed: true,
        birth_date_changed: false,
        notice_email: before,
        notice_sent_at: null,
      },
    ]);
    expect(world.email.lastTo(before)).toBeUndefined();

    await world.sweepNotices();

    const notice = world.email.lastTo(before);
    expect(notice).toBeDefined();
    // Generic on purpose (JD-S5 R3): it is sent to an address that may not be the patient's.
    expect(notice?.subject).toContain('Se registró un cambio');
    expect(notice?.text).not.toMatch(/ficha|paciente/i);
    // A warning, never a way in: no link, no code, no new address, no name.
    expect(notice?.text).not.toMatch(/https?:/);
    expect(notice?.text).not.toContain(after);
    expect(world.email.lastTo(after)).toBeUndefined();
    const sent = (await auditsOf('portal.notice.sent')).filter(
      (entry) => entry.patientId === patient,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.metadata).toMatchObject({ kind: 'record_changed' });
    expect(JSON.stringify(sent[0]?.metadata)).not.toContain(before);
    // The address does not stay in the table once it was told.
    const told = await changesOf(patient);
    expect(told.rows[0]?.notice_email).toBeNull();
    expect(told.rows[0]?.notice_sent_at).not.toBeNull();
    // Running the worker again tells nobody twice.
    await world.sweepNotices();
    expect(world.email.sent.filter((message) => message.to === before)).toHaveLength(1);
  });

  it('tells the address of the record when the birth date changes', async () => {
    const record = address('ficha');
    const patient = await world.patientWith({ birthDate: '1985-03-10', email: record });

    const response = await patch(patient, { birthDate: '1984-03-10' });
    expect(response.statusCode, response.body).toBe(200);
    await world.sweepNotices();

    const notice = world.email.lastTo(record);
    expect(notice?.text).toContain('Se registró un cambio');
    expect(notice?.text).not.toContain('1984');
    expect((await changesOf(patient)).rows[0]).toMatchObject({
      email_changed: false,
      birth_date_changed: true,
    });
  });

  it('tells nobody when the record had no address, but the change is recorded all the same', async () => {
    const patient = await world.patientWith({ birthDate: '1985-03-10', email: null });
    const sentBefore = world.email.sent.length;

    const response = await patch(patient, { email: address('nuevo') });
    expect(response.statusCode, response.body).toBe(200);
    await world.sweepNotices();

    expect(world.email.sent.length).toBe(sentBefore);
    expect((await changesOf(patient)).rows).toEqual([
      expect.objectContaining({ email_changed: true, notice_email: null }),
    ]);
  });

  it('records nothing for a change that changes nothing (the same address in other letters)', async () => {
    const record = address('Mismo');
    const patient = await world.patientWith({ birthDate: '1985-03-10', email: record });

    const response = await patch(patient, { email: record.toUpperCase() });
    expect(response.statusCode, response.body).toBe(200);

    expect((await changesOf(patient)).rows).toEqual([]);
  });

  it('does not let the application role edit or erase what was recorded', async () => {
    const patient = await world.patientWith({ birthDate: '1985-03-10', email: address('x') });
    await patch(patient, { email: address('y') });

    await expect(
      world.inTenant((tx) =>
        tx.execute(
          sql`update patient_record_change set created_at = now() where patient_id = ${patient}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
    await expect(
      world.inTenant((tx) =>
        tx.execute(sql`delete from patient_record_change where patient_id = ${patient}`),
      ),
    ).rejects.toBeDefined();
  });
});

describe('R2-2 (2): for seven days after a change, access needs an owner or an administrator', () => {
  it.each([
    ['the e-mail of the record', { email: address('nuevo') }],
    ['the birth date of the record', { birthDate: '1984-03-10' }],
  ] as const)(
    'refuses reception to invite the patient after %s changed, and allows an administrator',
    async (_what, change) => {
      const patient = await world.patientWith({ birthDate: '1985-03-10', email: address('base') });
      expect((await patch(patient, change)).statusCode).toBe(200);

      const refused = await world.invite(patient, {}, world.reception);

      expect(refused.statusCode, refused.body).toBe(409);
      expect(problemOf(refused).code).toBe('portal_recent_identity_change');
      expect((await world.portalOf(patient)).identities).toEqual([]);
      const denied = (await auditsOf('access.denied')).filter(
        (entry) => entry.patientId === patient && entry.reason === 'portal_recent_identity_change',
      );
      expect(denied).toHaveLength(1);

      const allowed = await world.invite(patient, {}, world.admin);
      expect(allowed.statusCode, allowed.body).toBe(201);
      const created = (await auditsOf('portal.identity.created')).filter(
        (entry) => entry.patientId === patient,
      );
      expect(created.at(-1)?.metadata).toMatchObject({ afterRecordChange: true });
    },
  );

  it('refuses reception a representative for a minor whose birth date changed, and allows the owner', async () => {
    const record = address('ficha');
    const patient = await world.patientWith({ birthDate: '1985-03-10', email: record });
    // The birth date is corrected in the database: the screen would ask for a representative, and the
    // trigger is what records the change, whoever makes it.
    await world.inTenant((tx) =>
      tx.execute(sql`update patient set birth_date = '2018-06-01' where id = ${patient}`),
    );
    const parent = address('madre');
    const body = { email: parent, relation: 'mother', verificationNote: NOTE };

    const refused = await world.invite(patient, body, world.reception);

    expect(refused.statusCode, refused.body).toBe(409);
    expect(problemOf(refused).code).toBe('portal_recent_identity_change');
    expect(world.email.lastTo(parent)).toBeUndefined();
    const allowed = await world.invite(patient, body, world.owner);
    expect(allowed.statusCode, allowed.body).toBe(201);
  });

  it('allows reception again once the week is over', async () => {
    const patient = await world.patientWith({ birthDate: '1985-03-10', email: address('base') });
    expect((await patch(patient, { email: address('nuevo') })).statusCode).toBe(200);
    expect((await world.invite(patient, {}, world.reception)).statusCode).toBe(409);
    // The worker tells the previous address within the week; a notice nobody was told keeps the
    // registration closed whatever its age (JD-S5 R4-1, covered in portal-record-change-round4).
    await world.sweepNotices();

    await ageChanges(patient, 6);
    expect((await world.invite(patient, {}, world.reception)).statusCode).toBe(409);
    await ageChanges(patient, 2);

    const allowed = await world.invite(patient, {}, world.reception);
    expect(allowed.statusCode, allowed.body).toBe(201);
  });

  it('refuses reception to link a minor to an account, and to restore a suspended link', async () => {
    const parentEmail = address('padre');
    const child = await world.patientWith({ birthDate: '2020-09-14', email: address('hijo') });
    const identity = await world.inviteOk(
      child,
      { email: parentEmail, relation: 'mother', verificationNote: NOTE },
      world.admin,
    );
    await world.activate(world.activationPathSentTo(parentEmail));
    const sibling = await world.patientWith({ birthDate: '2021-01-02', email: address('hermano') });
    expect((await patch(sibling, { email: address('otro') })).statusCode).toBe(200);
    const body = { patientId: sibling, relation: 'mother', verificationNote: NOTE };

    const refused = await world.api.post(
      `/portal-identities/${identity.id}/links`,
      world.reception,
      body,
    );
    const allowed = await world.api.post(
      `/portal-identities/${identity.id}/links`,
      world.admin,
      body,
    );

    expect(refused.statusCode, refused.body).toBe(409);
    expect(problemOf(refused).code).toBe('portal_recent_identity_change');
    expect(allowed.statusCode, allowed.body).toBe(201);

    // A link suspended by mistake is restored by reception only when the record was not touched.
    const linkId = allowed
      .json<{ identity: PortalIdentityDto }>()
      .identity.links.find((link) => link.patientId === sibling)?.id;
    await world.inTenant((tx) =>
      tx.execute(
        sql`update portal_link set status = 'suspended', suspended_at = now() where id = ${linkId ?? ''}`,
      ),
    );
    const restore = await world.api.post(
      `/portal-links/${linkId ?? ''}/authorize`,
      world.reception,
      {
        verificationNote: 'Verificado otra vez en el mostrador.',
      },
    );
    expect(restore.statusCode, restore.body).toBe(409);
    expect(problemOf(restore).code).toBe('portal_recent_identity_change');
  });

  it('refuses a registration with the document and the new address of the record during the week', async () => {
    const nationalId = String(30_000_000 + Math.floor(Math.random() * 9_000_000));
    const patient = await world.patientWith({
      birthDate: '1985-03-10',
      email: address('base'),
      nationalIdType: 'dni',
      nationalId,
    });
    const insider = address('insider');
    expect((await patch(patient, { email: insider })).statusCode).toBe(200);
    const visitor = world.visitor({ ip: '10.50.1.1' });

    const asked = await visitor.post(`/public/${SLUG}/portal/register`, {
      nationalId,
      email: insider,
      challengeProof: await visitor.solve(),
    });
    await world.runJobs();

    // The answer is the one everybody gets, and no code is sent to the new address.
    expect(asked.statusCode, asked.body).toBe(200);
    expect(world.email.lastTo(insider)).toBeUndefined();

    await world.sweepNotices();
    await ageChanges(patient, 8);
    const again = world.visitor({ ip: '10.50.1.2' });
    await again.post(`/public/${SLUG}/portal/register`, {
      nationalId,
      email: insider,
      challengeProof: await again.solve(),
    });
    await world.runJobs();
    expect(world.email.lastTo(insider)).toBeDefined();
  });
});

describe('R2-2 (3): the notice of an e-mail change of an account goes through the outbox', () => {
  it('queues the notice in the transaction of the change, and the worker sends it to the OLD address', async () => {
    const parentEmail = address('padre');
    const child = await world.patientWith({ birthDate: '2020-09-14', email: address('hijo') });
    await world.inviteOk(child, { email: parentEmail, relation: 'mother', verificationNote: NOTE });
    await world.activate(world.activationPathSentTo(parentEmail));
    const identity = (await world.portalOf(child)).identities[0] as PortalIdentityDto;
    const moved = address('nuevo');
    const queued = () => world.jobs.jobs.filter((job) => job.name === 'portal.notice_send').length;
    const before = queued();

    const response = await world.api.post(`/portal-identities/${identity.id}/email`, world.owner, {
      email: moved,
      verificationNote: 'Verificó su identidad por teléfono con su fecha de nacimiento.',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(queued()).toBe(before + 1);
    expect(
      world.email.sent.filter((message) => message.to === parentEmail).at(-1)?.subject,
    ).not.toContain('correo de acceso');
    await world.runJobs();
    const notice = world.email.lastTo(parentEmail);
    expect(notice?.subject).toContain('correo');
    expect(notice?.text).not.toMatch(/https?:/);
    expect(notice?.text).not.toContain(moved);
    const sent = (await auditsOf('portal.notice.sent')).filter(
      (entry) => entry.resourceId === identity.id,
    );
    expect(sent.map((entry) => entry.metadata)).toContainEqual({ kind: 'email_changed' });
  });
});

describe('R2-2 (4): a representative for a minor with no e-mail on the record', () => {
  it('needs an owner or an administrator, to invite and to link', async () => {
    const child = await world.patientWith({ birthDate: '2020-09-14', email: null });
    const parent = address('madre');
    const body = { email: parent, relation: 'mother', verificationNote: NOTE };

    const refused = await world.invite(child, body, world.reception);

    expect(refused.statusCode, refused.body).toBe(409);
    expect(problemOf(refused).code).toBe('portal_owner_or_admin_required');
    expect(world.email.lastTo(parent)).toBeUndefined();
    const denied = (await auditsOf('access.denied')).filter(
      (entry) => entry.patientId === child && entry.reason === 'portal_owner_or_admin_required',
    );
    expect(denied).toHaveLength(1);

    for (const role of ['owner', 'admin'] as const) {
      const other = await world.patientWith({ birthDate: '2020-09-14', email: null });
      const allowed = await world.invite(
        other,
        { ...body, email: address(`madre-${role}`) },
        world[role],
      );
      expect(allowed.statusCode, allowed.body).toBe(201);
    }

    // An account that exists (its child has an address on the record), and a sibling that has none.
    const withEmail = await world.patientWith({ birthDate: '2020-01-01' });
    const accountEmail = address('padre');
    const identity = await world.inviteOk(
      withEmail,
      { email: accountEmail, relation: 'mother', verificationNote: NOTE },
      world.admin,
    );
    await world.activate(world.activationPathSentTo(accountEmail));
    const linked = await world.patientWith({ birthDate: '2021-09-14', email: null });
    const reception = await world.api.post(
      `/portal-identities/${identity.id}/links`,
      world.reception,
      { patientId: linked, relation: 'mother', verificationNote: NOTE },
    );
    expect(reception.statusCode, reception.body).toBe(409);
    expect(problemOf(reception).code).toBe('portal_owner_or_admin_required');
  });
});
