import { randomUUID } from 'node:crypto';

import type { Problem } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFakeEmailSender } from '../../src/adapters/fake-email/index.js';
import { sendRecordChangeNotices } from '../../src/modules/portal/application/notice-job.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { createPortalWorld, type PortalWorld } from '../support/portal-world.js';

/**
 * JD-S5 R4, the record changes of a patient:
 *
 * - R4-1: a notice that nobody was told keeps the registration closed whatever its age, so a worker
 *   that is down on day 8 does not open the registration of a record whose previous address was never
 *   warned;
 * - R4-3: a give-up of the sweep does not close again a registration that an owner already opened;
 * - R4-6: the database refuses to expire a notice without closing the registration.
 */
const SLUG = 'portal-record-change-r4';
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

const address = (prefix: string) => `${prefix}-${randomUUID().slice(0, 6)}@example.test`;
const nationalIdOf = () => String(30_000_000 + Math.floor(Math.random() * 9_000_000));

const patch = (patientId: string, body: Record<string, unknown>) =>
  world.api.patch(`/patients/${patientId}`, world.reception, body);

interface ChangeRow extends Record<string, unknown> {
  notice_email: string | null;
  notice_sent_at: string | null;
  notice_expired_at: string | null;
  registration_requires_invitation: boolean;
  invitation_opened_at: string | null;
}

const changesOf = async (patientId: string) =>
  (
    await world.inTenant((tx) =>
      tx.execute<ChangeRow>(
        sql`select notice_email, notice_sent_at, notice_expired_at,
                   registration_requires_invitation, invitation_opened_at
              from patient_record_change where patient_id = ${patientId} order by created_at`,
      ),
    )
  ).rows;

/** Ages the changes of a patient, the way days going by do (the table is immutable for the application). */
async function ageChanges(patientId: string, days: number): Promise<void> {
  await admin.query(
    `BEGIN;
     set local session_replication_role = replica;
     update patient_record_change set created_at = created_at - interval '${String(days)} days'
      where patient_id = '${patientId}';
     COMMIT;`,
  );
}

async function askToRegister(
  who: ReturnType<PortalWorld['visitor']>,
  input: { nationalId: string; email: string },
) {
  return who.post(`/public/${SLUG}/portal/register`, {
    ...input,
    challengeProof: await who.solve(),
  });
}

let ips = 0;
const stranger = () =>
  world.visitor({ ip: `10.64.${String(Math.floor(ips / 200))}.${String((ips += 1) % 200)}` });

describe('R4-1: a notice nobody was told keeps the registration closed whatever its age', () => {
  it('refuses the public registration and a reception invitation on day 8 with the sweep not run; an owner opens it', async () => {
    const nationalId = nationalIdOf();
    const before = address('antes');
    const after = address('despues');
    const patient = await world.patientWith({ nationalId, email: before, birthDate: '1985-03-10' });
    expect((await patch(patient, { email: after })).statusCode).toBe(200);
    expect((await changesOf(patient))[0]).toMatchObject({
      notice_email: before,
      registration_requires_invitation: false,
    });

    // Day 8, and the worker never ran: the week is over, the flag is still down, the row is untold.
    await ageChanges(patient, 8);

    expect((await askToRegister(stranger(), { nationalId, email: after })).statusCode).toBe(200);
    await world.runJobs();
    expect(world.email.lastTo(after)).toBeUndefined();

    const byReception = await world.invite(patient);
    expect(byReception.statusCode, byReception.body).toBe(409);
    expect(byReception.json<Problem>().code).toBe('portal_owner_or_admin_required');

    // An owner invites the patient: that covers the untold notice too.
    const byOwner = await world.invite(patient, {}, world.owner);
    expect(byOwner.statusCode, byOwner.body).toBe(201);
    expect((await changesOf(patient))[0]?.invitation_opened_at).not.toBeNull();
    const done = await world.activate(world.activationPathSentTo(after));
    expect(done.done.statusCode, done.done.body).toBe(200);
  });

  it('opens again by itself once the notice is told (the old address knows)', async () => {
    const nationalId = nationalIdOf();
    const before = address('antes');
    const after = address('despues');
    const patient = await world.patientWith({ nationalId, email: before, birthDate: '1985-03-10' });
    expect((await patch(patient, { email: after })).statusCode).toBe(200);
    await world.sweepNotices();
    await ageChanges(patient, 8);

    expect((await askToRegister(stranger(), { nationalId, email: after })).statusCode).toBe(200);
    await world.runJobs();
    expect(world.email.lastTo(after)).toBeDefined();
  });
});

describe('R4-3: a give-up does not close again a registration an owner opened', () => {
  it('sets the opening on the row it expires when an invitation was opened after that row was written', async () => {
    const nationalId = nationalIdOf();
    const patient = await world.patientWith({
      nationalId,
      email: address('uno'),
      birthDate: '1985-03-10',
    });
    // Rows 1 and 2 hold a notice nobody was told; row 3 (the record lost its address and got another,
    // so nobody was to be told) is flagged.
    const setEmail = (email: string | null) =>
      world.inTenant((tx) =>
        tx.execute(sql`update patient set email = ${email} where id = ${patient}`),
      );
    await setEmail(address('dos'));
    await setEmail(null);
    await setEmail(address('tres'));
    expect(await changesOf(patient)).toHaveLength(3);
    // An owner opened the registration after all of them (an opening that did not reach the first
    // two rows: the state a database left by an earlier version can hold).
    await admin.query(
      `BEGIN;
       set local session_replication_role = replica;
       update patient_record_change set invitation_opened_at = now()
        where patient_id = '${patient}' and registration_requires_invitation;
       COMMIT;`,
    );
    await ageChanges(patient, 8);

    // The sweep gives the two old notices up (the week is over).
    const swept = await sendRecordChangeNotices(
      {
        email: createFakeEmailSender(),
        withTenant: createWithTenant(runtime.db),
        log: { error: () => undefined },
      },
      { tenantId: world.tenant.id, now: new Date() },
    );
    expect(swept.expired).toBeGreaterThanOrEqual(2);

    // No row of the patient closes the registration again after the opening.
    const open = await world.inTenant((tx) =>
      tx.execute<{ closed: boolean }>(
        sql`select exists (
              select 1 from patient_record_change
               where patient_id = ${patient}
                 and registration_requires_invitation and invitation_opened_at is null
            ) as closed`,
      ),
    );
    expect(open.rows[0]?.closed).toBe(false);
  });
});

describe('R4-6: the database refuses to expire a notice without closing the registration', () => {
  it('refuses notice_expired_at with the flag down, and accepts it with the flag up', async () => {
    const patient = await world.patientWith({ email: address('base'), birthDate: '1985-03-10' });
    expect((await patch(patient, { email: address('otra') })).statusCode).toBe(200);

    await expect(
      world.inTenant((tx) =>
        tx.execute(
          sql`update patient_record_change set notice_email = null, notice_expired_at = now()
               where patient_id = ${patient}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });

    await expect(
      world.inTenant((tx) =>
        tx.execute(
          sql`update patient_record_change
                 set notice_email = null, notice_expired_at = now(),
                     registration_requires_invitation = true
               where patient_id = ${patient}`,
        ),
      ),
    ).resolves.toBeDefined();
  });
});
