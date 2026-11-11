import { randomUUID } from 'node:crypto';

import type { PortalMeResponse, Problem } from '@consultorio/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFakeEmailSender } from '../../src/adapters/fake-email/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { sendRecordChangeNotices } from '../../src/modules/portal/application/notice-job.js';
import { createMajorityReviewJob } from '../../src/modules/portal/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import { EmailDeliveryError, type EmailMessage } from '../../src/platform/mail/email-sender.js';
import { createPortalWorld, type PortalWorld } from '../support/portal-world.js';
import { createTestTenant } from '../support/tenants.js';

/**
 * JD-S5 R3, the record changes of a patient:
 *
 * - R3-4: an address given to a record that had none (or whose previous address could not be told)
 *   closes the PUBLIC registration of that patient until an owner or an administrator invites them;
 * - R3-5: the sweep of notices claims a row in a short transaction, sends outside any transaction and
 *   marks it in another, retries a bounded number of times, never repeats a notice whose audit
 *   failed, and logs and audits the ones that expire;
 * - R3-6: the portal reads and writes none of the table, and only the trigger inserts into it;
 * - B-W2: a later birth date never extends the access of a representative.
 */
const SLUG = 'portal-record-change-r3';
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
const problemOf = (response: LightMyRequestResponse) => response.json<Problem>();
const NOTE = 'Presentó su DNI y la partida de nacimiento.';

const patch = (patientId: string, body: Record<string, unknown>) =>
  world.api.patch(`/patients/${patientId}`, world.reception, body);

const auditsOf = (action: string) =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, action as never))),
  );

interface ChangeRow extends Record<string, unknown> {
  notice_email: string | null;
  notice_sent_at: string | null;
  notice_expired_at: string | null;
  notice_attempts: number;
  notice_claimed_at: string | null;
  notice_next_attempt_at: string | null;
  registration_requires_invitation: boolean;
  invitation_opened_at: string | null;
}

const changesOf = async (patientId: string) =>
  (
    await world.inTenant((tx) =>
      tx.execute<ChangeRow>(
        sql`select notice_email, notice_sent_at, notice_expired_at, notice_attempts, notice_claimed_at,
                   notice_next_attempt_at, registration_requires_invitation, invitation_opened_at
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
  world.visitor({ ip: `10.60.${String(Math.floor(ips / 200))}.${String((ips += 1) % 200)}` });

/** The notice sweep, with its own sender, logger and transactions. */
function sweepWith(options: {
  email?: { send(message: EmailMessage): Promise<void> };
  now?: Date;
}) {
  const logged: { object: Record<string, unknown>; message: string }[] = [];
  const email = options.email ?? createFakeEmailSender();
  return {
    logged,
    run: () =>
      sendRecordChangeNotices(
        {
          email: email,
          withTenant: createWithTenant(runtime.db),
          log: { error: (object, message) => logged.push({ object, message }) },
        },
        { tenantId: world.tenant.id, now: options.now ?? new Date() },
      ),
  };
}

describe('R3-4: an address given to a record that had none closes the public registration', () => {
  it('keeps the registration closed after the week, until an owner or an administrator invites the patient', async () => {
    const nationalId = nationalIdOf();
    const patient = await world.patientWith({ nationalId, email: null, birthDate: '1985-03-10' });
    const email = address('nuevo');
    expect((await patch(patient, { email })).statusCode).toBe(200);
    expect((await changesOf(patient))[0]).toMatchObject({
      notice_email: null,
      registration_requires_invitation: true,
      invitation_opened_at: null,
    });
    await ageChanges(patient, 8);

    // The week is over, but nobody was ever told: whoever typed the address asks for a code in vain.
    expect((await askToRegister(stranger(), { nationalId, email })).statusCode).toBe(200);
    await world.runJobs();
    expect(world.email.lastTo(email)).toBeUndefined();

    // Reception cannot open it either.
    const byReception = await world.invite(patient);
    expect(byReception.statusCode, byReception.body).toBe(409);
    expect(problemOf(byReception).code).toBe('portal_owner_or_admin_required');

    // An administrator invites the patient: an explicit act, in the trail, that opens the registration.
    const invited = await world.invite(patient, {}, world.admin);
    expect(invited.statusCode, invited.body).toBe(201);
    expect((await changesOf(patient))[0]?.invitation_opened_at).not.toBeNull();
    const opened = (await auditsOf('portal.registration.opened')).filter(
      (entry) => entry.patientId === patient,
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]?.actorUserId).toEqual(expect.any(String));
    expect(JSON.stringify(opened[0]?.metadata)).not.toContain(email);

    // The patient follows the link of the invitation, and from then on reception is not needed.
    const done = await world.activate(world.activationPathSentTo(email));
    expect(done.done.statusCode, done.done.body).toBe(200);
  });

  it('does not close it when the record had an address that was told (the owner of the old address knows)', async () => {
    const nationalId = nationalIdOf();
    const before = address('antes');
    const after = address('despues');
    const patient = await world.patientWith({ nationalId, email: before, birthDate: '1985-03-10' });
    expect((await patch(patient, { email: after })).statusCode).toBe(200);
    expect((await changesOf(patient))[0]?.registration_requires_invitation).toBe(false);
    await world.sweepNotices();
    await ageChanges(patient, 8);

    expect((await askToRegister(stranger(), { nationalId, email: after })).statusCode).toBe(200);
    await world.runJobs();

    expect(world.email.lastTo(after)).toBeDefined();
  });

  it('does not close it for a change of the birth date alone', async () => {
    const patient = await world.patientWith({ email: address('x'), birthDate: '1985-03-10' });
    expect((await patch(patient, { birthDate: '1984-03-10' })).statusCode).toBe(200);
    expect((await changesOf(patient))[0]?.registration_requires_invitation).toBe(false);
  });

  it('closes it when the notice of a change could not be told before the week ended', async () => {
    const nationalId = nationalIdOf();
    const before = address('rebota');
    const after = address('nueva');
    const patient = await world.patientWith({ nationalId, email: before, birthDate: '1985-03-10' });
    expect((await patch(patient, { email: after })).statusCode).toBe(200);
    await ageChanges(patient, 8);

    const sweep = sweepWith({
      email: { send: () => Promise.reject(new EmailDeliveryError({ cause: new Error('bounce') })) },
    });
    await sweep.run();

    const [row] = await changesOf(patient);
    expect(row).toMatchObject({
      notice_email: null,
      notice_sent_at: null,
      registration_requires_invitation: true,
    });
    expect(row?.notice_expired_at).not.toBeNull();
    expect((await askToRegister(stranger(), { nationalId, email: after })).statusCode).toBe(200);
    await world.runJobs();
    expect(world.email.lastTo(after)).toBeUndefined();
  });
});

describe('R3-5: the sweep of notices', () => {
  const changedRecord = async () => {
    const before = address('aviso');
    const patient = await world.patientWith({ email: before, birthDate: '1985-03-10' });
    expect((await patch(patient, { email: address('otro') })).statusCode).toBe(200);
    return { patient, before };
  };

  it('logs a send that fails, keeps the row, and tries again after a wait', async () => {
    const { patient, before } = await changedRecord();
    const failing = sweepWith({
      email: {
        send: () => Promise.reject(new EmailDeliveryError({ cause: new Error('smtp down') })),
      },
    });

    const first = await failing.run();

    expect(first).toMatchObject({ sent: 0 });
    expect(failing.logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(failing.logged)).not.toContain(before);
    const [after] = await changesOf(patient);
    expect(after).toMatchObject({ notice_attempts: 1, notice_claimed_at: null });
    expect(after?.notice_email).toBe(before);
    expect(after?.notice_next_attempt_at).not.toBeNull();

    // Not again at once: the wait has to pass.
    const sender = createFakeEmailSender();
    const immediate = await sweepWith({ email: sender }).run();
    expect(immediate).toMatchObject({ sent: 0 });
    expect(sender.sent).toHaveLength(0);

    await admin.query(
      `BEGIN;
       set local session_replication_role = replica;
       update patient_record_change set notice_next_attempt_at = now() - interval '1 minute'
        where patient_id = '${patient}';
       COMMIT;`,
    );
    const later = await sweepWith({ email: sender }).run();
    expect(later).toMatchObject({ sent: 1 });
    expect(sender.lastTo(before)).toBeDefined();
  });

  it('gives up after five failures, logs it, audits portal.notice.expired and closes the registration', async () => {
    const { patient } = await changedRecord();
    const failing = sweepWith({
      email: {
        send: () => Promise.reject(new EmailDeliveryError({ cause: new Error('smtp down') })),
      },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await failing.run();
      await admin.query(
        `BEGIN;
         set local session_replication_role = replica;
         update patient_record_change set notice_next_attempt_at = null where patient_id = '${patient}';
         COMMIT;`,
      );
    }

    const [row] = await changesOf(patient);
    expect(row).toMatchObject({
      notice_email: null,
      notice_sent_at: null,
      registration_requires_invitation: true,
    });
    expect(row?.notice_expired_at).not.toBeNull();
    const expired = (await auditsOf('portal.notice.expired')).filter(
      (entry) => entry.patientId === patient,
    );
    expect(expired).toHaveLength(1);
    expect(expired[0]?.metadata).toMatchObject({ kind: 'record_changed', reason: 'send_failed' });
    expect(failing.logged.some((entry) => entry.message.includes('expired'))).toBe(true);
  });

  it('expires, logs and audits the notices of a week that ended unsent', async () => {
    const { patient } = await changedRecord();
    await ageChanges(patient, 8);
    const sweep = sweepWith({});

    const result = await sweep.run();

    expect(result.expired).toBeGreaterThanOrEqual(1);
    const [row] = await changesOf(patient);
    expect(row).toMatchObject({ notice_email: null, registration_requires_invitation: true });
    const expired = (await auditsOf('portal.notice.expired')).filter(
      (entry) => entry.patientId === patient,
    );
    expect(expired[0]?.metadata).toMatchObject({ reason: 'week_over' });
    expect(sweep.logged.some((entry) => entry.message.includes('expired'))).toBe(true);
  });

  it('sends outside any transaction: the claim is committed while the message is in flight', async () => {
    const { patient, before } = await changedRecord();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const slow = {
      send: async () => {
        entered();
        await gate;
      },
    };
    const running = sweepWith({ email: slow }).run();
    await inside;

    // Seen from another connection: the claim is written, the row is not told yet, and a second
    // sweep leaves it alone (it sends nothing).
    const [claimed] = await changesOf(patient);
    expect(claimed?.notice_claimed_at).not.toBeNull();
    expect(claimed?.notice_sent_at).toBeNull();
    const sender = createFakeEmailSender();
    await sweepWith({ email: sender }).run();
    expect(sender.lastTo(before)).toBeUndefined();

    release();
    await running;
    expect((await changesOf(patient))[0]?.notice_sent_at).not.toBeNull();
  });

  it('does not send a notice twice when its audit fails after the send', async () => {
    const { patient, before } = await changedRecord();
    // The audit of the notice fails (a trigger of the test), after the message left.
    await admin.query(`
      CREATE OR REPLACE FUNCTION public.zz_fail_notice_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'portal.notice.sent' THEN
          RAISE EXCEPTION 'the audit failed' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER zz_fail_notice_audit BEFORE INSERT ON audit_event
        FOR EACH ROW EXECUTE FUNCTION public.zz_fail_notice_audit();`);
    const sender = createFakeEmailSender();
    try {
      const first = sweepWith({ email: sender });
      await first.run();
      expect(first.logged.length).toBeGreaterThan(0);
      expect(sender.sent.filter((message) => message.to === before)).toHaveLength(1);

      // Every minute for a long while: the notice does not go out again.
      for (let pass = 0; pass < 3; pass += 1) await sweepWith({ email: sender }).run();
      await admin.query(
        `BEGIN;
         set local session_replication_role = replica;
         update patient_record_change set notice_claimed_at = null where patient_id = '${patient}';
         COMMIT;`,
      );
      await sweepWith({ email: sender }).run();
    } finally {
      await admin.query(`
        DROP TRIGGER IF EXISTS zz_fail_notice_audit ON audit_event;
        DROP FUNCTION IF EXISTS public.zz_fail_notice_audit();`);
    }

    expect(sender.sent.filter((message) => message.to === before)).toHaveLength(1);
    const [row] = await changesOf(patient);
    expect(row?.notice_sent_at).not.toBeNull();
    expect(row?.notice_email).toBeNull();
  });

  it('two sweeps at once tell the address once', async () => {
    const { before } = await changedRecord();
    const sender = createFakeEmailSender();

    await Promise.all([
      sweepWith({ email: sender }).run(),
      sweepWith({ email: sender }).run(),
      sweepWith({ email: sender }).run(),
    ]);

    expect(sender.sent.filter((message) => message.to === before)).toHaveLength(1);
  });
});

describe('R3-6: the table of record changes', () => {
  it('shows a transaction of the portal no row and lets it write none', async () => {
    const patient = await world.patientWith({ email: address('base'), birthDate: '1985-03-10' });
    expect((await patch(patient, { email: address('otra') })).statusCode).toBe(200);
    const asPortal = <T>(
      work: (tx: Parameters<Parameters<typeof world.inTenant>[0]>[0]) => Promise<T>,
    ) =>
      world.inTenant(async (tx) => {
        await tx.execute(sql`select set_config('app.actor_kind', 'portal', true)`);
        return work(tx);
      });

    const seen = await asPortal((tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from patient_record_change`),
    );
    expect(seen.rows[0]?.n).toBe(0);
    await expect(
      asPortal((tx) =>
        tx.execute(
          sql`update patient_record_change set notice_claimed_at = now() where patient_id = ${patient}`,
        ),
      ),
    ).resolves.toBeDefined();
    expect((await changesOf(patient))[0]?.notice_claimed_at).toBeNull();
  });

  it('lets the trigger write the row of a change made from a transaction of the portal', async () => {
    const patient = await world.patientWith({ email: address('base'), birthDate: '1985-03-10' });

    await world.inTenant(async (tx) => {
      await tx.execute(sql`select set_config('app.actor_kind', 'portal', true)`);
      await tx.execute(
        sql`update patient set email = ${address('desde-portal')} where id = ${patient}`,
      );
    });

    expect(await changesOf(patient)).toHaveLength(1);
  });

  it('gives the application role no INSERT: a forged row (a mail to any address) is refused', async () => {
    const patient = await world.patientWith({ email: address('base'), birthDate: '1985-03-10' });

    await expect(
      world.inTenant((tx) =>
        tx.execute(
          sql`insert into patient_record_change (tenant_id, patient_id, email_changed, birth_date_changed, notice_email)
              values (${world.tenant.id}, ${patient}, true, false, 'victima@example.test')`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('keeps the composite key of the tenant: even the owner cannot point a row at a patient of another organization', async () => {
    const patient = await world.patientWith({ email: address('base'), birthDate: '1985-03-10' });
    const other = await createTestTenant(runtime, { slug: 'portal-record-change-r3-other' });
    const owner = new pg.Client({ connectionString: inject('ownerUrl') });
    await owner.connect();
    try {
      await owner.query('BEGIN');
      await owner.query(`select set_config('app.tenant_id', $1, true)`, [other.id]);
      await expect(
        owner.query(
          `insert into patient_record_change (tenant_id, patient_id, email_changed, birth_date_changed)
           values ($1, $2, true, false)`,
          [other.id, patient],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await owner.query('ROLLBACK');
      await owner.end();
    }
  });

  it('refuses to clear the address of a notice that was neither told nor expired', async () => {
    const patient = await world.patientWith({ email: address('base'), birthDate: '1985-03-10' });
    expect((await patch(patient, { email: address('otra') })).statusCode).toBe(200);

    await expect(
      world.inTenant((tx) =>
        tx.execute(
          sql`update patient_record_change set notice_email = null where patient_id = ${patient}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
    await expect(
      world.inTenant((tx) =>
        tx.execute(
          sql`update patient_record_change set registration_requires_invitation = false where patient_id = ${patient}`,
        ),
      ),
    ).resolves.toBeDefined();
  });

  it('never lowers the flag of a closed registration', async () => {
    const patient = await world.patientWith({ email: null, birthDate: '1985-03-10' });
    expect((await patch(patient, { email: address('nuevo') })).statusCode).toBe(200);

    await expect(
      world.inTenant((tx) =>
        tx.execute(
          sql`update patient_record_change set registration_requires_invitation = false where patient_id = ${patient}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
  });
});

describe('B-W2: a later birth date does not extend the access of a representative', () => {
  it('keeps the original day, so the representative loses access at the original 18th birthday', async () => {
    // The clock of this world is 2031-05-05: the child turns 18 on 2031-06-06 (17 years and 11 months).
    // Through the screen of reception, as a real record is made: a minor comes with a contact.
    const made = await world.api.post('/patients', world.reception, {
      familyName: 'Hijo',
      givenNames: 'Prueba',
      birthDate: '2013-06-06',
      document: { type: 'dni', number: nationalIdOf() },
      email: address('hijo'),
      dataProcessingConsent: true,
      representative: { fullName: 'Madre Prueba', relation: 'mother', phone: '1155550000' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const child = made.json<{ patient: { id: string } }>().patient.id;
    const parentEmail = address('madre');
    await world.inviteOk(child, { email: parentEmail, relation: 'mother', verificationNote: NOTE });
    await world.activate(world.activationPathSentTo(parentEmail));
    const parent = await world.signInAs(parentEmail);
    const reviewDay = async () =>
      (
        await world.inTenant((tx) =>
          tx.execute<{ day: string }>(
            sql`select majority_review_on::text as day from portal_link where patient_id = ${child}`,
          ),
        )
      ).rows[0]?.day;
    expect(await reviewDay()).toBe('2031-06-06');

    // Reception corrects the birth date a year LATER (the child would be a minor for a year more).
    const moved = await patch(child, { birthDate: '2014-06-06' });
    expect(moved.statusCode, moved.body).toBe(200);

    expect(await reviewDay()).toBe('2031-06-06');
    const job = createMajorityReviewJob({ clock: () => new Date('2031-06-06T12:00:00.000Z') });
    expect(
      await runJob(runtime.db, job, {
        id: randomUUID(),
        name: job.name,
        data: { tenantId: world.tenant.id },
        enqueuedAt: new Date(),
        retryCount: 0,
      }),
    ).toEqual({ status: 'completed' });
    const me = (await parent.get('/portal/me')).json<PortalMeResponse>();
    expect(me.links[0]).toMatchObject({ status: 'suspended' });
  });

  it('still brings the day EARLIER when the birth date is corrected to an earlier one', async () => {
    const child = await world.patientWith({ birthDate: '2013-06-06', email: address('hijo') });
    const parentEmail = address('padre');
    await world.inviteOk(child, { email: parentEmail, relation: 'father', verificationNote: NOTE });
    await world.activate(world.activationPathSentTo(parentEmail));

    expect((await patch(child, { birthDate: '2012-06-06' })).statusCode).toBe(200);

    const day = await world.inTenant((tx) =>
      tx.execute<{ day: string }>(
        sql`select majority_review_on::text as day from portal_link where patient_id = ${child}`,
      ),
    );
    expect(day.rows[0]?.day).toBe('2030-06-06');
  });
});

describe('R3 suspect: restoring a representative tells the address of the record, like the first time', () => {
  it('queues the notice of the restored link', async () => {
    const recordEmail = address('ficha');
    const child = await world.patientWith({ birthDate: '2013-06-06', email: recordEmail });
    const parentEmail = address('madre');
    await world.inviteOk(child, { email: parentEmail, relation: 'mother', verificationNote: NOTE });
    await world.activate(world.activationPathSentTo(parentEmail));
    await world.runJobs();
    world.email.clear();
    const link = await world.inTenant((tx) =>
      tx.execute<{ id: string }>(
        sql`update portal_link set status = 'suspended', suspended_at = now()
             where patient_id = ${child} returning id`,
      ),
    );

    const restored = await world.api.post(
      `/portal-links/${link.rows[0]?.id ?? ''}/authorize`,
      world.reception,
      { verificationNote: 'Verificado otra vez en el mostrador.' },
    );
    expect(restored.statusCode, restored.body).toBe(200);
    await world.runJobs();

    const notice = world.email.lastTo(recordEmail);
    expect(notice?.subject).toContain('representante');
    expect(notice?.text).not.toMatch(/https?:/);
  });
});
