import type {
  BookingLinkDto,
  PublicWaitlistJoinRequest,
  PublicWaitlistJoinResponse,
  PublicWaitlistJoinedResponse,
} from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { patient } from '../../src/db/schema/patients.js';
import { tenant } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBookingWorld, type BookingWorld, type Visitor } from '../support/booking-world.js';

/**
 * Joining the waitlist from the public page: a form, a code by email, and only then an entry. The
 * world is the one of the online booking (links, bot challenge, visitors), with the waitlist wired
 * the way production wires it.
 */

const NOW = new Date('2031-05-05T12:00:00.000Z');
let runtime: DbHandle;
let world: BookingWorld;
let links: { organization: BookingLinkDto; professional: BookingLinkDto };
let forms = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBookingWorld(runtime, { slug: 'waitlist-join', now: NOW });
  links = await world.openLinks();
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const path = (suffix = '') => `/public/${links.organization.slug}/waitlist${suffix}`;

/** A valid form with a document and an email of its own. */
function form(overrides: Partial<Omit<PublicWaitlistJoinRequest, 'challengeProof'>> = {}) {
  forms += 1;
  return {
    professional: links.professional.slug,
    appointmentTypeId: world.consulta,
    givenNames: 'Lucía',
    familyName: `Espera ${String(forms)}`,
    document: { type: 'dni', number: String(31_000_000 + forms) },
    birthDate: '1990-04-02',
    email: `espera${String(forms)}@example.test`,
    phone: '+54 11 5555 0000',
    weekdays: [1],
    timeRanges: [{ from: '08:00', to: '13:00' }],
    offersOptIn: true,
    dataProcessingConsent: true,
    ...overrides,
  };
}

async function submit(visitor: Visitor, body: ReturnType<typeof form>) {
  return visitor.post(path(), { ...body, challengeProof: await visitor.solve() });
}

/** The visitor submits the form and reads the code from their email. */
async function requested(
  body = form(),
  visitor = world.visitor(),
): Promise<{ body: ReturnType<typeof form>; visitor: Visitor; id: string; code: string }> {
  const response = await submit(visitor, body);
  expect(response.statusCode, response.body).toBe(200);
  const { id } = response.json<PublicWaitlistJoinResponse>();
  return { body, visitor, id, code: world.codeSentTo(body.email) };
}

const confirm = (visitor: Visitor, id: string, code: string) =>
  visitor.post(path(`/${id}/confirm`), { code });

const entriesOf = (document: string) =>
  world.inTenant(
    async (tx) =>
      (
        await tx.execute(
          sql`SELECT e.* FROM waitlist_entry e JOIN patient p ON p.id = e.patient_id
                WHERE p.national_id = ${document}`,
        )
      ).rows,
  );

const patientsWith = (document: string) =>
  world.inTenant((tx) => tx.select().from(patient).where(eq(patient.nationalId, document)));

describe('asking to join', () => {
  it('stores the form encrypted, creates no patient and no entry, and sends the code to the address in the form', async () => {
    const body = form();

    const response = await submit(world.visitor(), body);

    expect(response.statusCode, response.body).toBe(200);
    const answer = response.json<PublicWaitlistJoinResponse>();
    expect(answer.maskedEmail).toMatch(/^e\*\*\*@example\.test$/);
    expect(new Date(answer.codeExpiresAt).getTime()).toBe(NOW.getTime() + 10 * 60_000);
    expect(world.codeSentTo(body.email)).toMatch(/^\d{6}$/);
    expect(world.email.sent.filter((message) => message.to === body.email)).toHaveLength(1);

    expect(await patientsWith(body.document.number)).toEqual([]);
    expect(await entriesOf(body.document.number)).toEqual([]);
    const [stored] = await world.inTenant(
      async (tx) =>
        (
          await tx.execute<{ kind: string; status: string; email: string; plain: boolean }>(
            sql`SELECT kind, status, email,
                       position(convert_to(${body.familyName}, 'UTF8') in payload_enc) > 0 AS plain
                  FROM booking_submission WHERE id = ${answer.id}`,
          )
        ).rows,
    );
    expect(stored).toEqual({
      kind: 'waitlist_join',
      status: 'unverified',
      email: body.email,
      plain: false,
    });
  });

  it('says what the code is for, and carries nothing but the code', async () => {
    const body = form();
    await submit(world.visitor(), body);

    const message = world.email.lastTo(body.email);

    expect(message?.subject).toContain('lista de espera');
    expect(message?.text).toContain('lista de espera');
    expect(message?.text).not.toContain(body.familyName);
    expect(message?.text).not.toMatch(/https?:\/\//);
  });

  it('asks for the data-processing consent and for the agreement to receive offers', async () => {
    const noConsent = await submit(world.visitor(), form({ dataProcessingConsent: false }));
    const noOptIn = await submit(world.visitor(), form({ offersOptIn: false }));

    expect(noConsent.statusCode).toBe(400);
    expect(noConsent.json()).toMatchObject({
      code: 'validation_failed',
      errors: [{ path: 'dataProcessingConsent', i18nKey: 'waitlist.consent_required' }],
    });
    expect(noOptIn.statusCode).toBe(400);
    expect(noOptIn.json()).toMatchObject({ code: 'waitlist_opt_in_required' });
  });

  it('refuses an invalid document, a birth date in the future and a minor', async () => {
    const document = await submit(
      world.visitor(),
      form({ document: { type: 'dni', number: '12' } }),
    );
    const future = await submit(world.visitor(), form({ birthDate: '2031-06-01' }));
    const minor = await submit(world.visitor(), form({ birthDate: '2020-01-01' }));

    expect(document.json()).toMatchObject({ errors: [{ path: 'document' }] });
    expect(future.json()).toMatchObject({ errors: [{ path: 'birthDate' }] });
    expect(minor.json()).toMatchObject({
      errors: [{ path: 'birthDate', i18nKey: 'booking.minor_contact_organization' }],
    });
    for (const response of [document, future, minor]) expect(response.statusCode).toBe(400);
  });

  it('wants a number to send offers over WhatsApp', async () => {
    const response = await submit(
      world.visitor(),
      form({ channels: ['email', 'whatsapp'], phone: undefined }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ errors: [{ path: 'phone' }] });
  });

  it('answers a professional, a type or a place the link does not expose like an address that is not live', async () => {
    const unknownProfessional = await submit(
      world.visitor(),
      form({ professional: 'doesnotexist01' }),
    );
    const otherType = await submit(world.visitor(), form({ appointmentTypeId: world.withBuffer }));
    const otherPlace = await submit(world.visitor(), form({ locationId: world.norte }));
    const wrongOrganization = await world.visitor().post(`/public/organizationx/waitlist`, {
      ...form(),
      challengeProof: 'whatever',
    });

    for (const response of [unknownProfessional, otherType, otherPlace]) {
      expect(response.statusCode).toBe(404);
    }
    // The same answer for all of them: nothing tells which part was wrong.
    const code = (response: typeof otherType) => response.json<{ code: string }>().code;
    expect(code(unknownProfessional)).toBe('not_found');
    expect(code(otherType)).toBe('not_found');
    expect(code(otherPlace)).toBe('not_found');
    expect([400, 404]).toContain(wrongOrganization.statusCode);
  });

  it('ignores an organization or a role the visitor makes up', async () => {
    const visitor = world.visitor();
    const body = { ...form(), tenantId: '0190a000-0000-7000-8000-00000000dead', role: 'owner' };

    const response = await visitor.post(path(), {
      ...body,
      challengeProof: await visitor.solve(),
    });

    expect(response.statusCode, response.body).toBe(200);
    const [stored] = await world.inTenant(
      async (tx) =>
        (
          await tx.execute<{ tenant_id: string }>(
            sql`SELECT tenant_id FROM booking_submission
                  WHERE id = ${response.json<PublicWaitlistJoinResponse>().id}`,
          )
        ).rows,
    );
    expect(stored?.tenant_id).toBe(world.tenant.id);
  });

  it('needs the proof of the bot challenge, and a proof works once', async () => {
    const visitor = world.visitor();
    const body = form();
    const proof = await visitor.solve();

    const first = await visitor.post(path(), { ...body, challengeProof: proof });
    const replay = await visitor.post(path(), { ...form(), challengeProof: proof });
    const wrong = await visitor.post(path(), { ...form(), challengeProof: 'not-a-proof' });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ code: 'booking_challenge_failed' });
    expect(wrong.json()).toMatchObject({ code: 'booking_challenge_failed' });
  });

  it('limits the codes sent to one address to three an hour, and the forms of one address', async () => {
    const body = form();
    const results = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      results.push(await submit(world.visitor(), { ...body }));
    }

    expect(results.map((response) => response.statusCode)).toEqual([200, 200, 200, 429]);
    expect(world.email.sent.filter((message) => message.to === body.email)).toHaveLength(3);
  });
});

describe('proving the address', () => {
  it('creates the patient and the entry only now, and answers the same whoever the visitor is', async () => {
    const { body, visitor, id, code } = await requested();

    const joined = await confirm(visitor, id, code);

    expect(joined.statusCode, joined.body).toBe(200);
    expect(joined.json<PublicWaitlistJoinedResponse>()).toEqual({
      joined: true,
      expiresAt: new Date(NOW.getTime() + 60 * 86_400_000).toISOString(),
    });
    const [created] = await patientsWith(body.document.number);
    expect(created).toMatchObject({ origin: 'online', givenNames: 'Lucía', email: body.email });
    const [entry] = await entriesOf(body.document.number);
    expect(entry).toMatchObject({
      patient_id: created?.id,
      appointment_type_id: world.consulta,
      professional_id: world.doctor.professionalId,
      location_id: null,
      weekdays: [1],
      time_ranges: [{ from: '08:00', to: '13:00' }],
      status: 'active',
      source: 'public_join',
      offers_opt_in_source: 'public_join',
      offers_opt_in_by: null,
      channels: ['email'],
      manual_contact_only: false,
      identity_unconfirmed: false,
    });
    expect(entry?.['offers_opt_in_at']).not.toBeNull();
  });

  it('keeps the consent of the form and nothing else of it once verified', async () => {
    const { body, visitor, id, code } = await requested();
    await confirm(visitor, id, code);

    const [row] = await world.inTenant(
      async (tx) =>
        (
          await tx.execute<{ status: string; verified: boolean; plain: boolean }>(
            sql`SELECT status, verified_at IS NOT NULL AS verified,
                       position(convert_to(${body.givenNames}, 'UTF8') in payload_enc) > 0 AS plain
                  FROM booking_submission WHERE id = ${id}`,
          )
        ).rows,
    );
    expect(row).toEqual({ status: 'verified', verified: true, plain: false });
    const consents = await world.inTenant(
      async (tx) =>
        (
          await tx.execute(
            sql`SELECT c.* FROM data_processing_consent c JOIN patient p ON p.id = c.patient_id
                  WHERE p.national_id = ${body.document.number}`,
          )
        ).rows,
    );
    expect(consents).toHaveLength(1);
  });

  it('attaches the entry to the patient the document belongs to, without changing the record', async () => {
    const document = '31999001';
    const existing = await world.inTenant(
      async (tx) =>
        (
          await tx.execute<{ id: string }>(
            sql`INSERT INTO patient (tenant_id, family_name, given_names, birth_date,
                                     national_id_type, national_id, email, phone)
                  VALUES (${world.tenant.id}, 'Original', 'Persona', '1985-01-01', 'dni',
                          ${document}, 'original@example.test', '+54 11 4444 0000')
                  RETURNING id`,
          )
        ).rows[0]?.id,
    );
    const { visitor, id, code } = await requested(
      form({
        document: { type: 'dni', number: document },
        givenNames: 'Otro',
        familyName: 'Nombre',
        email: 'otra@example.test',
        phone: '+54 11 9999 9999',
      }),
    );

    const joined = await confirm(visitor, id, code);

    expect(joined.statusCode, joined.body).toBe(200);
    const [entry] = await entriesOf(document);
    expect(entry).toMatchObject({
      patient_id: existing,
      source: 'public_join',
      identity_unconfirmed: true,
      status: 'active',
    });
    // Nobody on the record agreed to offers: a stranger cannot forge that agreement with a document
    // (JD-S3 C3). The entry waits for reception to call.
    expect(entry?.['offers_opt_in_at']).toBeNull();
    expect(entry?.['offers_opt_in_source']).toBeNull();
    expect(entry).toMatchObject({
      manual_contact_only: true,
      manual_reason: 'no_offers_opt_in',
    });
    // The record is exactly what the organization had.
    const [record] = await patientsWith(document);
    expect(record).toMatchObject({
      familyName: 'Original',
      givenNames: 'Persona',
      email: 'original@example.test',
      phone: '+54 11 4444 0000',
    });
    expect(await patientsWith(document)).toHaveLength(1);
  });

  it('gives a new patient and an existing one the same answer', async () => {
    const document = '31999002';
    await world.inTenant((tx) =>
      tx.execute(
        sql`INSERT INTO patient (tenant_id, family_name, given_names, birth_date,
                                 national_id_type, national_id)
              VALUES (${world.tenant.id}, 'Ya', 'Registrada', '1985-01-01', 'dni', ${document})`,
      ),
    );
    const fresh = await requested();
    const known = await requested(form({ document: { type: 'dni', number: document } }));

    const first = await confirm(fresh.visitor, fresh.id, fresh.code);
    const second = await confirm(known.visitor, known.id, known.code);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  it('only requests WhatsApp for a patient it registered: the link goes to the verified address and nothing is recorded (JD-S3 D22)', async () => {
    world.email.clear();
    const { body, visitor, id, code } = await requested(form({ channels: ['email', 'whatsapp'] }));
    await confirm(visitor, id, code);
    await world.app.background.idle();

    const sent = world.email.sent.filter((mail) => mail.to === body.email);
    const link = sent
      .map((mail) => /\/public\/t\/[A-Za-z0-9_-]{43}/.exec(mail.text)?.[0])
      .find(Boolean);
    expect(link).toBeDefined();
    const preferences = await world.inTenant(
      async (tx) =>
        (
          await tx.execute(
            sql`SELECT c.* FROM channel_preference c JOIN patient p ON p.id = c.patient_id
                  WHERE p.national_id = ${body.document.number}`,
          )
        ).rows,
    );
    expect(preferences).toEqual([]);
  });

  it('asks nothing for WhatsApp on a record that was already there', async () => {
    const document = '31999777';
    await world.inTenant((tx) =>
      tx.execute(
        sql`INSERT INTO patient (tenant_id, family_name, given_names, birth_date,
                                 national_id_type, national_id)
              VALUES (${world.tenant.id}, 'Ya', 'Estaba', '1985-01-01', 'dni', ${document})`,
      ),
    );
    world.email.clear();
    const known = await requested(
      form({ document: { type: 'dni', number: document }, channels: ['email', 'whatsapp'] }),
    );
    const before = world.email.sent.length;

    await confirm(known.visitor, known.id, known.code);
    await world.app.background.idle();

    expect(world.email.sent.slice(before)).toEqual([]);
  });

  it('records the WhatsApp choice on the entry, and reaches nobody on WhatsApp by itself', async () => {
    const { body, visitor, id, code } = await requested(form({ channels: ['email', 'whatsapp'] }));
    await confirm(visitor, id, code);

    const [entry] = await entriesOf(body.document.number);

    expect(entry).toMatchObject({ channels: ['email', 'whatsapp'], manual_contact_only: false });
  });

  it('refuses a wrong code, spends it after five, and a good code afterwards does not work', async () => {
    const { visitor, id, code } = await requested();
    const wrong = code === '000000' ? '111111' : '000000';

    const answers = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      answers.push(await confirm(visitor, id, wrong));
    }
    const late = await confirm(visitor, id, code);

    for (const answer of answers) {
      expect(answer.statusCode).toBe(400);
      expect(answer.json()).toMatchObject({ code: 'waitlist_code_invalid' });
    }
    expect(late.statusCode).toBe(400);
    expect(late.json()).toMatchObject({ code: 'waitlist_code_invalid' });
  });

  it('refuses a code that expired, and a request that does not exist', async () => {
    const { visitor, id, code } = await requested();
    world.advance(11 * 60_000);
    const expired = await confirm(visitor, id, code);
    world.advance(-11 * 60_000);
    const unknown = await confirm(visitor, '0190a000-0000-7000-8000-00000000dead', '123456');

    expect(expired.statusCode).toBe(400);
    expect(expired.json()).toMatchObject({ code: 'waitlist_code_invalid' });
    expect(unknown.statusCode).toBe(404);
  });

  it('uses a code once', async () => {
    const { visitor, id, code } = await requested();
    const first = await confirm(visitor, id, code);

    const second = await confirm(visitor, id, code);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(404);
  });

  it('sends the code again for the same request, and the new code replaces the old one', async () => {
    const { visitor, id, body, code: first } = await requested();
    world.email.clear();

    const resent = await visitor.post(path(`/${id}/code`), {
      challengeProof: await visitor.solve(),
    });
    const second = world.codeSentTo(body.email);
    const oldOne = await confirm(visitor, id, first);
    const newOne = await confirm(visitor, id, second);

    expect(resent.statusCode, resent.body).toBe(200);
    expect(second).not.toBe(first);
    expect(oldOne.statusCode).toBe(400);
    expect(newOne.statusCode).toBe(200);
  });

  it('answers a patient who already has the most entries, or the same wait, exactly like anybody else', async () => {
    const document = '31999003';
    const patientId = await world.inTenant(
      async (tx) =>
        (
          await tx.execute<{ id: string }>(
            sql`INSERT INTO patient (tenant_id, family_name, given_names, birth_date,
                                     national_id_type, national_id, email)
                  VALUES (${world.tenant.id}, 'Con', 'Esperas', '1985-01-01', 'dni',
                          ${document}, 'esperas@example.test')
                  RETURNING id`,
          )
        ).rows[0]?.id,
    );
    const first = await requested(form({ document: { type: 'dni', number: document } }));
    expect((await confirm(first.visitor, first.id, first.code)).statusCode).toBe(200);
    expect(await entriesOf(document)).toHaveLength(1);
    await world.api.patch('/settings', world.owner, { waitlist: { maxActiveEntries: 1 } });
    try {
      // The same wait again, then a different one past the limit.
      const duplicate = await requested(form({ document: { type: 'dni', number: document } }));
      const past = await requested(
        form({
          document: { type: 'dni', number: document },
          professional: links.professional.slug,
          locationId: world.centro,
        }),
      );

      const answers = [
        await confirm(duplicate.visitor, duplicate.id, duplicate.code),
        await confirm(past.visitor, past.id, past.code),
      ];

      for (const answer of answers) {
        expect(answer.statusCode).toBe(200);
        expect(answer.json()).toMatchObject({ joined: true });
      }
      // Nothing was added, and nothing told the visitor why.
      expect(await entriesOf(document)).toHaveLength(1);
    } finally {
      await world.api.patch('/settings', world.owner, { waitlist: { maxActiveEntries: 5 } });
    }
    expect(patientId).toEqual(expect.any(String));
  });
});

describe('what is not verified', () => {
  it('is deleted after 24 hours with the code that went with it, and no patient or entry ever existed', async () => {
    const { body, id } = await requested();
    world.advance(25 * 3_600_000);
    await world.inTenant((tx) =>
      world.jobs.enqueue(tx, 'booking.purge', { tenantId: world.tenant.id }),
    );

    const results = await world.runJobs();

    expect(results.some((row) => row.name === 'booking.purge')).toBe(true);
    const left = await world.inTenant(
      async (tx) =>
        (await tx.execute(sql`SELECT id FROM booking_submission WHERE id = ${id}`)).rows,
    );
    expect(left).toEqual([]);
    expect(await patientsWith(body.document.number)).toEqual([]);
    expect(await entriesOf(body.document.number)).toEqual([]);
    world.advance(-25 * 3_600_000);
  });
});

describe('while the organization is read-only', () => {
  it('looks like a disabled link, and creates nothing', async () => {
    const body = form();
    const visitor = world.visitor();
    const proof = await visitor.solve();
    const set = (status: 'active' | 'read_only') =>
      world.inTenant((tx) =>
        tx
          .update(tenant)
          .set({ status, readOnlySince: status === 'read_only' ? new Date() : null })
          .where(eq(tenant.id, world.tenant.id)),
      );
    await set('read_only');
    try {
      const response = await visitor.post(path(), { ...body, challengeProof: proof });

      expect(response.statusCode).toBe(404);
      expect(world.email.sent.filter((message) => message.to === body.email)).toEqual([]);
    } finally {
      await set('active');
    }
  });
});
