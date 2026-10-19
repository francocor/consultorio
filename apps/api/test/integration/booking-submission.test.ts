import type { Problem, PublicHoldDto, PublicSubmissionResponse } from '@consultorio/contracts';
import { count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { bookingSubmission, otpChallenge } from '../../src/db/schema/booking-submission.js';
import { patient } from '../../src/db/schema/patients.js';
import { appointment, slotHold } from '../../src/db/schema/scheduling.js';
import { optOutPatient } from '../../src/modules/notifications/application/opt-out.js';
import { verifyCode } from '../../src/modules/online-booking/application/otp.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBookingWorld, type BookingWorld, type Visitor } from '../support/booking-world.js';
import { shapeOf } from '../support/security.js';

let runtime: DbHandle;
let world: BookingWorld;
let links: Awaited<ReturnType<BookingWorld['openLinks']>>;

const EARLY = new Date('2031-05-05T12:00:00.000Z');

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBookingWorld(runtime, { slug: 'booking-submission' });
  links = await world.openLinks();
  const settings = await world.api.patch('/settings', world.owner, {
    onlineBooking: { horizonDays: 365 },
  });
  expect(settings.statusCode, settings.body).toBe(200);
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

let week = 0;
/** A hold on a Monday of its own, so tests never compete for a slot. */
async function heldBy(visitor: Visitor = world.visitor()) {
  world.setNow(EARLY);
  week += 1;
  const hold = await world.hold(visitor, links, { weeksAfter: week });
  return { visitor, hold };
}

const submissionUrl = (hold: PublicHoldDto) =>
  `/public/${links.organization.slug}/booking/holds/${hold.id}/submission`;

async function submit(
  visitor: Visitor,
  hold: PublicHoldDto,
  form: ReturnType<BookingWorld['form']> = world.form(),
  extra: Record<string, unknown> = {},
) {
  return visitor.post(submissionUrl(hold), {
    ...form,
    challengeProof: await visitor.solve(),
    ...extra,
  });
}

const submissionRows = () => world.inTenant((tx) => tx.select().from(bookingSubmission));
const challengeRows = () => world.inTenant((tx) => tx.select().from(otpChallenge));
const countOf = async (table: typeof patient | typeof appointment) =>
  (await world.inTenant((tx) => tx.select({ n: count() }).from(table)))[0]?.n ?? 0;

describe('submitting the form', () => {
  it('stores the form unverified and encrypted, sends a code job, and creates no patient or appointment', async () => {
    const { visitor, hold } = await heldBy();
    const patients = await countOf(patient);
    const appointments = await countOf(appointment);
    const form = world.form({ email: 'paciente@example.test' });

    const response = await submit(visitor, hold, form);

    expect(response.statusCode, response.body).toBe(200);
    const answer = response.json<PublicSubmissionResponse>();
    expect(answer.maskedEmail).toBe('p***@example.test');
    expect(answer.codeExpiresAt).toBe(new Date(EARLY.getTime() + 10 * 60_000).toISOString());

    const [row] = (await submissionRows()).filter((entry) => entry.holdId === hold.id);
    expect(row).toMatchObject({
      kind: 'booking',
      status: 'unverified',
      email: 'paciente@example.test',
      verifiedAt: null,
      appointmentId: null,
    });
    expect(row?.purgeAfter.toISOString()).toBe(
      new Date(EARLY.getTime() + 24 * 3_600_000).toISOString(),
    );
    // Nothing patient-shaped exists before the code is verified.
    expect(await countOf(patient)).toBe(patients);
    expect(await countOf(appointment)).toBe(appointments);
    expect(world.jobs.pending('otp.send')).toHaveLength(1);
  });

  it('keeps no readable copy of the form in the database', async () => {
    const { visitor, hold } = await heldBy();
    const form = world.form({
      givenNames: 'Zenobia',
      familyName: 'Quispe',
      document: { type: 'dni', number: '27123456' },
      reason: 'consulta de control',
    });
    await submit(visitor, hold, form);

    const raw = await world.inTenant((tx) =>
      tx.execute<{ text: string }>(
        sql`SELECT encode(payload_enc, 'escape') AS text FROM booking_submission WHERE hold_id = ${hold.id}`,
      ),
    );

    const stored = raw.rows[0]?.text ?? '';
    expect(stored.length).toBeGreaterThan(20);
    for (const secret of ['Zenobia', 'Quispe', '27123456', 'consulta de control']) {
      expect(stored).not.toContain(secret);
    }
  });

  it('sends the code only to the address in the form, never to one on file for the same document', async () => {
    const { visitor, hold } = await heldBy();
    const onFile = world.form({
      document: { type: 'dni', number: '31555000' },
      email: 'on-file@example.test',
    });
    await world.inTenant((tx) =>
      tx.execute(
        sql`INSERT INTO patient (tenant_id, family_name, given_names, birth_date, national_id_type, national_id, email)
              VALUES (${world.tenant.id}, 'Archivo', 'Paciente', '1980-01-01', 'dni', '31555000', ${onFile.email})`,
      ),
    );
    world.email.clear();
    world.jobs.jobs.length = 0;

    const response = await submit(
      visitor,
      hold,
      world.form({ document: onFile.document, email: 'typed@example.test' }),
    );
    await world.runJobs();

    expect(response.statusCode, response.body).toBe(200);
    expect(world.email.sent.map((message) => message.to)).toEqual(['typed@example.test']);
    expect(world.email.lastTo('on-file@example.test')).toBeUndefined();
    // The answer is the same for a visitor whose document is on file: nothing says so.
    expect(response.json<PublicSubmissionResponse>().maskedEmail).toBe('t***@example.test');
  });

  it('still sends the code to the typed address when the record with that document opted out of every channel (B7)', async () => {
    const { visitor, hold } = await heldBy();
    const optedOut = world.form({
      document: { type: 'dni', number: '31555001' },
      email: 'baja@example.test',
    });
    await world.inTenant(async (tx) => {
      const inserted = await tx.execute<{ id: string }>(
        sql`INSERT INTO patient (tenant_id, family_name, given_names, birth_date, national_id_type, national_id, email)
              VALUES (${world.tenant.id}, 'Baja', 'Paciente', '1980-01-01', 'dni', '31555001', ${optedOut.email})
              RETURNING id`,
      );
      const patientId = inserted.rows[0]?.id ?? '';
      await optOutPatient(tx, {
        patientId,
        source: 'email_link',
        actor: { userId: null, actingRole: null, ip: null, userAgent: null, requestId: null },
      });
    });
    world.email.clear();
    world.jobs.jobs.length = 0;

    const response = await submit(
      visitor,
      hold,
      world.form({ document: optedOut.document, email: 'typed-baja@example.test' }),
    );
    await world.runJobs();

    expect(response.statusCode, response.body).toBe(200);
    // The visitor asked for the code at that moment: it goes out, and the answer is the one of any
    // other visitor (nothing says that the document is on file or that its record opted out).
    expect(world.email.sent.map((message) => message.to)).toEqual(['typed-baja@example.test']);
    expect(response.json<PublicSubmissionResponse>().maskedEmail).toBe('t***@example.test');
  });

  it('emails a six digit code that expires in ten minutes, and stores only its hash', async () => {
    const { visitor, hold } = await heldBy();
    const form = world.form();
    await submit(visitor, hold, form);
    world.email.clear();

    const ran = await world.runJobs();

    expect(ran.every((entry) => entry.result.status === 'completed')).toBe(true);
    const message = world.email.lastTo(form.email);
    expect(message?.subject).toContain('código');
    expect(message?.text).toContain('10 minutos');
    expect(message?.tenant).toEqual({ id: world.tenant.id, isDemo: false });
    const code = world.codeSentTo(form.email);
    const [challenge] = (await challengeRows()).filter((row) => row.email === form.email);
    expect(challenge?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(challenge?.codeHash).not.toContain(code);
    expect(challenge).toMatchObject({ purpose: 'booking', attempts: 0, consumedAt: null });
  });

  it('refuses a submission without the data-processing consent and says why', async () => {
    const { visitor, hold } = await heldBy();
    const before = (await submissionRows()).length;

    const response = await submit(visitor, hold, world.form({ dataProcessingConsent: false }));

    expect(response.statusCode).toBe(400);
    expect(response.json<Problem>().errors).toEqual([
      { path: 'dataProcessingConsent', i18nKey: 'booking.consent_required' },
    ]);
    expect((await submissionRows()).length).toBe(before);
    expect(world.jobs.pending('otp.send')).toHaveLength(0);
  });

  it.each([
    [
      'a document that fails the format',
      { document: { type: 'dni' as const, number: '123' } },
      'document',
    ],
    [
      'a WhatsApp choice without a mobile number',
      { whatsappOptIn: true, phone: undefined },
      'phone',
    ],
    ['a birth date in the future', { birthDate: '2099-01-01' }, 'birthDate'],
    ['a minor, who books through the organization', { birthDate: '2025-01-01' }, 'birthDate'],
  ])('refuses %s and creates nothing', async (_name, override, path) => {
    const { visitor, hold } = await heldBy();
    const before = (await submissionRows()).length;

    const response = await submit(visitor, hold, world.form(override));

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<Problem>().errors?.map((error) => error.path)).toContain(path);
    expect((await submissionRows()).length).toBe(before);
  });

  it('keeps the slot until the code expires, even when the form is sent at the end of the ten minutes of the hold (JD-S3 B6)', async () => {
    const { visitor, hold } = await heldBy();
    // Nine minutes in: a minute of the hold is left, and the code will live ten.
    world.advance(9 * 60_000);

    const response = await submit(visitor, hold, world.form());
    expect(response.statusCode, response.body).toBe(200);

    const [row] = await world.inTenant((tx) =>
      tx.select().from(slotHold).where(eq(slotHold.id, hold.id)),
    );
    expect(row?.expiresAt.getTime()).toBeGreaterThanOrEqual(world.now().getTime() + 10 * 60_000);
    expect(row?.status).toBe('active');
  });

  it('refuses a form that fails the bot challenge, and creates nothing', async () => {
    const { visitor, hold } = await heldBy();
    const before = (await submissionRows()).length;

    const response = await visitor.post(submissionUrl(hold), {
      ...world.form(),
      challengeProof: 'wrong',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<Problem>().code).toBe('booking_challenge_failed');
    expect((await submissionRows()).length).toBe(before);
  });

  it("answers a hold that is not the visitor's, or does not exist, as not found", async () => {
    const { hold } = await heldBy();
    const stranger = world.visitor();

    const other = await submit(stranger, hold);
    const never = await stranger.post(
      `/public/${links.organization.slug}/booking/holds/0190a000-0000-7000-8000-00000000dead/submission`,
      { ...world.form(), challengeProof: await stranger.solve() },
    );

    expect(other.statusCode).toBe(404);
    expect(never.statusCode).toBe(404);
  });

  it('answers a hold that ran out as a slot that is no longer available', async () => {
    const { visitor, hold } = await heldBy();
    world.advance(11 * 60_000);

    const response = await submit(visitor, hold);

    expect(response.statusCode).toBe(409);
    expect(response.json<Problem>().code).toBe('slot_no_longer_available');
    world.setNow(EARLY);
  });

  it('replaces the previous form of the same hold and sends a new code', async () => {
    const { visitor, hold } = await heldBy();
    const first = world.form({ email: 'first@example.test' });
    const second = world.form({ email: 'second@example.test' });
    await submit(visitor, hold, first);

    const response = await submit(visitor, hold, second);

    expect(response.statusCode, response.body).toBe(200);
    const rows = (await submissionRows()).filter((entry) => entry.holdId === hold.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe('second@example.test');
    expect((await challengeRows()).filter((row) => row.submissionId === rows[0]?.id)).toHaveLength(
      2,
    );
  });

  it('ignores an organization, role or patient identifier in the form', async () => {
    const { visitor, hold } = await heldBy();

    const response = await submit(visitor, hold, world.form(), {
      tenantId: '0190a000-0000-7000-8000-00000000dead',
      role: 'owner',
      patientId: '0190a000-0000-7000-8000-00000000beef',
    });

    expect(response.statusCode, response.body).toBe(200);
    const [row] = (await submissionRows()).filter((entry) => entry.holdId === hold.id);
    expect(row?.tenantId).toBe(world.tenant.id);
  });

  it('can be asked for the code again, with a new proof, for the same form', async () => {
    const { visitor, hold } = await heldBy();
    const form = world.form();
    await submit(visitor, hold, form);
    await world.runJobs();
    world.email.clear();

    const again = await visitor.post(submissionUrl(hold).replace('/submission', '/code'), {
      challengeProof: await visitor.solve(),
    });
    await world.runJobs();

    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<PublicSubmissionResponse>().maskedEmail).toBe(
      `${form.email.slice(0, 1)}***@example.test`,
    );
    expect(world.email.sent.map((message) => message.to)).toEqual([form.email]);
  });
});

describe('limits on the codes', () => {
  it('sends at most three codes an hour to one address and says nothing else about it', async () => {
    const address = 'flood@example.test';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { visitor, hold } = await heldBy();
      const ok = await submit(visitor, hold, world.form({ email: address }));
      expect(ok.statusCode, ok.body).toBe(200);
    }
    world.jobs.jobs.length = 0;
    const { visitor, hold } = await heldBy();

    const fourth = await submit(visitor, hold, world.form({ email: address }));

    expect(fourth.statusCode).toBe(429);
    expect(fourth.json<Problem>().code).toBe('rate_limited');
    expect(world.jobs.pending('otp.send')).toHaveLength(0);
    const flood = (await submissionRows()).filter((row) => row.email === address);
    expect(flood).toHaveLength(3);
  });

  it('records the flood for the administrator and counts it', async () => {
    const actions = await world.inTenant((tx) =>
      tx
        .select({ action: auditEvent.action, metadata: auditEvent.metadata })
        .from(auditEvent)
        .where(eq(auditEvent.action, 'booking.suspicious')),
    );

    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions.some((entry) => entry.metadata['reason'] === 'code_flood')).toBe(true);
    // No address, name or document: the entry says what happened and where, nothing about who.
    expect(JSON.stringify(actions)).not.toContain('flood@example.test');
    expect(world.metrics.get('booking_suspicious_total', { reason: 'code_flood' })).toBeGreaterThan(
      0,
    );
  });

  it('lets the address have codes again an hour later', async () => {
    world.advance(61 * 60_000);
    world.setNow(new Date(world.now().getTime()));
    const visitor = world.visitor();
    const hold = await world.hold(visitor, links, { weeksAfter: 40 });

    const response = await submit(visitor, hold, world.form({ email: 'flood@example.test' }));

    expect(response.statusCode, response.body).toBe(200);
    world.setNow(EARLY);
  });

  it('spends a code after five wrong attempts, even if the right one comes next', async () => {
    const { visitor, hold } = await heldBy();
    const form = world.form();
    await submit(visitor, hold, form);
    await world.runJobs();
    const code = world.codeSentTo(form.email);
    const [row] = (await submissionRows()).filter((entry) => entry.holdId === hold.id);
    const wrong = code === '000000' ? '111111' : '000000';

    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      outcomes.push(
        await world.inTenant((tx) =>
          verifyCode(tx, { submissionId: row?.id ?? '', code: wrong, now: world.now() }),
        ),
      );
    }
    const afterwards = await world.inTenant((tx) =>
      verifyCode(tx, { submissionId: row?.id ?? '', code, now: world.now() }),
    );

    expect(outcomes).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
    expect(afterwards).toBe('invalid');
  });

  it('accepts the right code once, and never again', async () => {
    const { visitor, hold } = await heldBy();
    const form = world.form();
    await submit(visitor, hold, form);
    await world.runJobs();
    const code = world.codeSentTo(form.email);
    const [row] = (await submissionRows()).filter((entry) => entry.holdId === hold.id);
    const verify = (value: string, at = world.now()) =>
      world.inTenant((tx) => verifyCode(tx, { submissionId: row?.id ?? '', code: value, now: at }));

    expect(await verify(code)).toBe('ok');
    expect(await verify(code)).toBe('invalid');
  });

  it('refuses a code after ten minutes', async () => {
    const { visitor, hold } = await heldBy();
    const form = world.form();
    await submit(visitor, hold, form);
    await world.runJobs();
    const code = world.codeSentTo(form.email);
    const [row] = (await submissionRows()).filter((entry) => entry.holdId === hold.id);

    const late = await world.inTenant((tx) =>
      verifyCode(tx, {
        submissionId: row?.id ?? '',
        code,
        now: new Date(world.now().getTime() + 10 * 60_000 + 1),
      }),
    );

    expect(late).toBe('invalid');
  });

  it('refuses a code that was never generated: the job has not run yet', async () => {
    const { visitor, hold } = await heldBy();
    await submit(visitor, hold, world.form());
    const [row] = (await submissionRows()).filter((entry) => entry.holdId === hold.id);

    const early = await world.inTenant((tx) =>
      verifyCode(tx, { submissionId: row?.id ?? '', code: '123456', now: world.now() }),
    );

    expect(early).toBe('invalid');
  });
});

describe('abuse protection', () => {
  it('does not answer differently before the code for a document that already holds three future online appointments (JD-S3 C2)', async () => {
    const document = { type: 'dni' as const, number: '29000111' };
    const patientId = await world.inTenant(async (tx) => {
      const result = await tx.execute<{ id: string }>(
        sql`INSERT INTO patient (tenant_id, family_name, given_names, birth_date, national_id_type, national_id)
              VALUES (${world.tenant.id}, 'Acaparador', 'Ana', '1985-05-05', 'dni', '29000111') RETURNING id`,
      );
      return result.rows[0]?.id ?? '';
    });
    for (const time of ['09:00', '10:00', '11:00']) {
      const booked = await world.api.post('/appointments', world.owner, {
        patientId,
        professionalId: world.colleague.professionalId,
        locationId: world.centro,
        appointmentTypeId: world.consulta,
        local: { date: world.monday(60), time },
      });
      expect(booked.statusCode, booked.body).toBe(201);
    }
    await world.inTenant((tx) =>
      tx.execute(sql`UPDATE appointment SET source = 'online' WHERE patient_id = ${patientId}`),
    );
    const { visitor, hold } = await heldBy();

    const known = await submit(visitor, hold, world.form({ document }));
    const elsewhere = await submit(
      visitor,
      hold,
      world.form({ document: { type: 'dni', number: '29000222' } }),
    );

    // A visitor who has proved nothing yet learns nothing about the document: the same answer, and
    // nothing flagged. The limits are applied after the code, on the address that was verified.
    expect(known.statusCode).toBe(200);
    expect(elsewhere.statusCode).toBe(200);
    expect(shapeOf(known)).toBe(shapeOf(elsewhere));
    const flagged = await world.inTenant((tx) =>
      tx
        .select({ metadata: auditEvent.metadata })
        .from(auditEvent)
        .where(eq(auditEvent.action, 'booking.suspicious')),
    );
    expect(flagged.some((entry) => entry.metadata['reason'] === 'hoarding')).toBe(false);
  });

  it('limits the forms one address may send in an hour', async () => {
    const { visitor, hold } = await heldBy(world.visitor({ ip: '10.88.0.1' }));
    let last = 200;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await submit(visitor, hold, world.form());
      last = response.statusCode;
      if (last === 429) break;
    }

    expect(last).toBe(429);
    expect(world.metrics.get('booking_suspicious_total', { reason: 'rate_limit' })).toBeGreaterThan(
      0,
    );
  });

  it('writes what looked suspicious without who did it, and once per link and reason in a window (JD-S3 A6)', async () => {
    const { visitor, hold } = await heldBy(
      world.visitor({ ip: '10.88.0.2', userAgent: 'flood-agent' }),
    );
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await submit(visitor, hold, world.form());
    }

    const rows = await world.inTenant((tx) =>
      tx
        .select({
          ip: auditEvent.ip,
          userAgent: auditEvent.userAgent,
          metadata: auditEvent.metadata,
        })
        .from(auditEvent)
        .where(eq(auditEvent.action, 'booking.suspicious')),
    );

    // This file already provoked the limit once (the test before): a flood writes one entry.
    expect(rows.filter((row) => row.metadata['reason'] === 'rate_limit')).toHaveLength(1);
    for (const row of rows) {
      expect(row.ip).toBeNull();
      expect(row.userAgent).toBeNull();
    }
    // The metric still counts every one of them.
    expect(world.metrics.get('booking_suspicious_total', { reason: 'rate_limit' })).toBeGreaterThan(
      1,
    );
  });

  it('keeps the slot of a form that was refused: the hold is untouched', async () => {
    const { visitor, hold } = await heldBy();
    await submit(visitor, hold, world.form({ dataProcessingConsent: false }));

    const [row] = await world.inTenant((tx) =>
      tx.select().from(slotHold).where(eq(slotHold.id, hold.id)),
    );
    expect(row?.status).toBe('active');
  });
});

describe('abandoned submissions (booking.purge)', () => {
  it('deletes the unverified ones older than 24 hours with their codes, and nothing else', async () => {
    world.setNow(EARLY);
    const old = await heldBy();
    const oldForm = world.form({ email: 'old@example.test' });
    await submit(old.visitor, old.hold, oldForm);
    await world.runJobs();

    world.advance(25 * 3_600_000);
    const fresh = await world.hold(world.visitor(), links, { weeksAfter: 50 });
    const freshVisitor = world.visitor();
    const freshHold = await world.hold(freshVisitor, links, { weeksAfter: 51 });
    await submit(freshVisitor, freshHold, world.form({ email: 'fresh@example.test' }));
    expect(fresh.id).toBeDefined();
    const patients = await countOf(patient);

    world.jobs.jobs.length = 0;
    await world.runJobs();
    // The purge is queued per organization by the worker; run it the way the tick does.
    await world.inTenant(async (tx) => {
      const { purgeAbandoned } =
        await import('../../src/modules/online-booking/application/purge.js');
      await purgeAbandoned(tx, { now: world.now() });
    });

    const left = (await submissionRows()).map((row) => row.email);
    expect(left).not.toContain('old@example.test');
    expect(left).toContain('fresh@example.test');
    expect((await challengeRows()).map((row) => row.email)).not.toContain('old@example.test');
    expect(await countOf(patient)).toBe(patients);
    world.setNow(EARLY);
  });

  it('never touches a verified submission, however old', async () => {
    const { visitor, hold } = await heldBy();
    await submit(visitor, hold, world.form({ email: 'kept@example.test' }));
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE booking_submission SET status = 'verified', verified_at = now(), purge_after = now() - interval '5 days' WHERE email = 'kept@example.test'`,
      ),
    );

    await world.inTenant(async (tx) => {
      const { purgeAbandoned } =
        await import('../../src/modules/online-booking/application/purge.js');
      await purgeAbandoned(tx, { now: new Date('2040-01-01T00:00:00Z') });
    });

    expect((await submissionRows()).map((row) => row.email)).toContain('kept@example.test');
  });

  it('deletes the codes that expired more than an hour ago, and keeps the rest for the limit of sends', async () => {
    const { visitor, hold } = await heldBy();
    await submit(visitor, hold, world.form({ email: 'live@example.test' }));

    await world.inTenant(async (tx) => {
      const { purgeAbandoned } =
        await import('../../src/modules/online-booking/application/purge.js');
      await purgeAbandoned(tx, { now: new Date(world.now().getTime() + 71 * 60_000) });
    });

    // The submission is young, so it stays; its code expired an hour ago, so it goes.
    expect((await submissionRows()).map((row) => row.email)).toContain('live@example.test');
    expect((await challengeRows()).map((row) => row.email)).not.toContain('live@example.test');

    // Ten minutes after it expired it is still there: the limit of sends counts on it.
    await submit(visitor, hold, world.form({ email: 'counted@example.test' }));
    await world.inTenant(async (tx) => {
      const { purgeAbandoned } =
        await import('../../src/modules/online-booking/application/purge.js');
      await purgeAbandoned(tx, { now: new Date(world.now().getTime() + 20 * 60_000) });
    });
    expect((await challengeRows()).map((row) => row.email)).toContain('counted@example.test');
  });
});
