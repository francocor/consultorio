import type { PublicHoldDto } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBookingWorld, type BookingWorld, type Visitor } from '../support/booking-world.js';
import { countQueries, shapeOf } from '../support/security.js';

/**
 * Enumeration resistance of the public surface (online-booking, "Booking completion and patient
 * identification" and "Abuse protection"; waitlist, "Joining the waitlist"). A visitor with nothing
 * but an address and a document number must not be able to learn whether a person is a patient of
 * the organization, whether a link ever existed, or why a link does not work. Every question below
 * is asked twice, once about something that exists and once about something that does not, and the
 * two answers must be the same: status, headers, body, and the work the server did to produce them.
 */

let runtime: DbHandle;
let world: BookingWorld;
let links: Awaited<ReturnType<BookingWorld['openLinks']>>;

const EARLY = new Date('2031-05-05T12:00:00.000Z');
const KNOWN_DOCUMENT = '30111222';
const KNOWN = {
  given: 'Vera',
  family: 'Víctima',
  phone: '+54 11 4444 1111',
  email: 'vera@example.test',
};
let week = 0;
let people = 0;

/** A patient of the organization, with a document of their own. */
async function patientOnFile() {
  people += 1;
  const number = String(30_200_000 + people);
  await world.inTenant((tx) =>
    tx.execute(
      sql`INSERT INTO patient (tenant_id, family_name, given_names, birth_date, national_id_type, national_id, phone, email)
            VALUES (${world.tenant.id}, ${KNOWN.family}, ${KNOWN.given}, '1980-01-01', 'dni', ${number}, ${KNOWN.phone}, ${KNOWN.email})`,
    ),
  );
  return number;
}

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBookingWorld(runtime, { slug: 'sec-nondisclosure' });
  links = await world.openLinks();
  const settings = await world.api.patch('/settings', world.owner, {
    onlineBooking: { horizonDays: 365 },
  });
  expect(settings.statusCode, settings.body).toBe(200);
  await world.inTenant((tx) =>
    tx.execute(
      sql`INSERT INTO patient (tenant_id, family_name, given_names, birth_date, national_id_type, national_id, phone, email)
            VALUES (${world.tenant.id}, ${KNOWN.family}, ${KNOWN.given}, '1980-01-01', 'dni', ${KNOWN_DOCUMENT}, ${KNOWN.phone}, ${KNOWN.email})`,
    ),
  );
  await world.delegateCalendar(world.reception, [world.doctor.professionalId]);
}, 120_000);

afterAll(async () => {
  await world.close();
  await runtime.close();
});

interface Booking {
  visitor: Visitor;
  hold: PublicHoldDto;
  form: ReturnType<BookingWorld['form']>;
  submission: Awaited<ReturnType<Visitor['post']>>;
}

/** A visitor who held a Monday slot and submitted the form; the code is on its way. */
async function submitted(overrides: Parameters<BookingWorld['form']>[0] = {}): Promise<Booking> {
  world.setNow(EARLY);
  week += 1;
  const visitor = world.visitor();
  const hold = await world.hold(visitor, links, { weeksAfter: week, time: '10:00' });
  const form = world.form(overrides);
  const submission = await visitor.post(
    `/public/${links.organization.slug}/booking/holds/${hold.id}/submission`,
    { ...form, challengeProof: await visitor.solve() },
  );
  expect(submission.statusCode, submission.body).toBe(200);
  await world.runJobs();
  return { visitor, hold, form, submission };
}

const confirmPath = (hold: PublicHoldDto) =>
  `/public/${links.organization.slug}/booking/holds/${hold.id}/confirm`;

describe('the booking form', () => {
  it('answers the same for a document that belongs to a patient and one that does not', async () => {
    const unknown = await submitted();
    const known = await submitted({
      document: { type: 'dni', number: KNOWN_DOCUMENT },
      // The answer masks the visitor's own address; both start with the same letter.
      email: 'lucas.visitor@example.test',
    });

    expect(shapeOf(known.submission)).toBe(shapeOf(unknown.submission));
  });

  it('sends the code only to the address the visitor gave, whoever the document belongs to', async () => {
    world.email.clear();
    const known = await submitted({
      document: { type: 'dni', number: KNOWN_DOCUMENT },
      email: 'attacker@example.test',
    });

    expect(world.email.sent.map((message) => message.to)).toEqual(['attacker@example.test']);
    expect(world.codeSentTo(known.form.email)).toMatch(/^\d{6}$/);
    // Nothing the organization holds about the patient is in what the visitor receives.
    const mail = JSON.stringify(world.email.sent);
    for (const secret of [KNOWN.given, KNOWN.family, KNOWN.phone, KNOWN.email]) {
      expect(mail).not.toContain(secret);
    }
  });
});

describe('the confirmation of a booking', () => {
  /** The same visitor story twice: once for somebody new, once with the document of a patient. */
  async function confirmedBoth(extra: Parameters<BookingWorld['form']>[0] = {}) {
    const fresh = await submitted(extra);
    const existing = await submitted({
      ...extra,
      document: { type: 'dni', number: await patientOnFile() },
      email: `impostor${String(week)}@example.test`,
      givenNames: 'Otra',
      familyName: 'Persona',
    });
    const answers: Awaited<ReturnType<Visitor['post']>>[] = [];
    const queries: number[] = [];
    for (const booking of [fresh, existing]) {
      queries.push(
        await countQueries(async () => {
          answers.push(
            await booking.visitor.post(confirmPath(booking.hold), {
              code: world.codeSentTo(booking.form.email),
            }),
          );
          await world.app.background.idle();
        }),
      );
    }
    return { answers, queries };
  }

  it('answers the same for a new person and for an existing patient, and says nothing of the record', async () => {
    const { answers } = await confirmedBoth();

    const [freshAnswer, existingAnswer] = answers;
    expect(freshAnswer?.statusCode, freshAnswer?.body).toBe(200);
    expect(existingAnswer?.statusCode, existingAnswer?.body).toBe(200);
    // The same fields, the same kind of values: nothing says the person already existed.
    const keys = (response: typeof freshAnswer) => Object.keys(response?.json() ?? {}).sort();
    expect(keys(existingAnswer)).toEqual(keys(freshAnswer));
    expect(existingAnswer?.json()).toMatchObject({ status: 'scheduled' });
    const text = existingAnswer?.body ?? '';
    for (const secret of [KNOWN.given, KNOWN.family, KNOWN.phone, KNOWN.email]) {
      expect(text).not.toContain(secret);
    }
  });

  it('does the same amount of work for a new person and for an existing patient', async () => {
    const { queries } = await confirmedBoth();

    expect(queries[1]).toBe(queries[0]);
  });

  it('does the same amount of work when the visitor also asks for WhatsApp', async () => {
    const { queries } = await confirmedBoth({ whatsappOptIn: true });

    expect(queries[1]).toBe(queries[0]);
  });
});

describe('the waitlist form', () => {
  const path = (suffix = '') => `/public/${links.organization.slug}/waitlist${suffix}`;
  let forms = 0;
  let freshDocuments = 0;

  async function requested(document: string, email: string, extra: Record<string, unknown> = {}) {
    forms += 1;
    const visitor = world.visitor();
    const body = {
      professional: links.professional.slug,
      appointmentTypeId: world.consulta,
      givenNames: 'Persona',
      familyName: `Espera ${String(forms)}`,
      document: { type: 'dni', number: document },
      birthDate: '1990-04-02',
      email,
      phone: '+54 11 5555 0000',
      weekdays: [1],
      timeRanges: [{ from: '08:00', to: '13:00' }],
      offersOptIn: true,
      dataProcessingConsent: true,
      ...extra,
    };
    const response = await visitor.post(path(), { ...body, challengeProof: await visitor.solve() });
    expect(response.statusCode, response.body).toBe(200);
    await world.runJobs();
    return { visitor, response, id: response.json<{ id: string }>().id, email };
  }

  it('answers the same to a document that belongs to a patient and to one that does not', async () => {
    const unknown = await requested('31900001', 'lucas.one@example.test');
    const known = await requested(KNOWN_DOCUMENT, 'lucas.two@example.test');

    expect(shapeOf(known.response)).toBe(shapeOf(unknown.response));
  });

  async function confirmedBoth(extra: Record<string, unknown> = {}, tag = 'a') {
    freshDocuments += 1;
    const fresh = await requested(
      String(31_900_000 + freshDocuments),
      `lucas.${tag}1@example.test`,
      extra,
    );
    const existing = await requested(await patientOnFile(), `lucas.${tag}2@example.test`, extra);
    const answers: Awaited<ReturnType<Visitor['post']>>[] = [];
    const queries: number[] = [];
    for (const join of [fresh, existing]) {
      queries.push(
        await countQueries(async () => {
          answers.push(
            await join.visitor.post(path(`/${join.id}/confirm`), {
              code: world.codeSentTo(join.email),
            }),
          );
          await world.app.background.idle();
        }),
      );
    }
    return { answers, queries };
  }

  it('confirms with the same answer for a new person and for an existing patient', async () => {
    const { answers } = await confirmedBoth();

    expect(answers.map((answer) => answer.statusCode)).toEqual([200, 200]);
    const [freshAnswer, existingAnswer] = answers;
    expect(Object.keys(existingAnswer?.json() ?? {}).sort()).toEqual(
      Object.keys(freshAnswer?.json() ?? {}).sort(),
    );
    for (const secret of [KNOWN.given, KNOWN.family, KNOWN.phone, KNOWN.email]) {
      expect(existingAnswer?.body ?? '').not.toContain(secret);
    }
  });

  it('does the same amount of work for a new person and for an existing patient', async () => {
    const { queries } = await confirmedBoth({}, 'b');

    expect(queries[1]).toBe(queries[0]);
  });

  it('does the same amount of work when the visitor also asks for WhatsApp', async () => {
    const { queries } = await confirmedBoth({ channels: ['email', 'whatsapp'] }, 'c');

    expect(queries[1]).toBe(queries[0]);
  });
});

describe('an address that is not live', () => {
  const pageOf = (slug: string) => `/public/${slug}/booking`;
  const professionalOf = (slug: string, professional: string) =>
    `/public/${slug}/p/${professional}`;
  const availabilityOf = (slug: string, professional: string) =>
    `/public/${slug}/booking/availability?professional=${professional}&typeId=${world.consulta}&from=2031-05-12&to=2031-05-18`;

  const setStatus = (status: 'active' | 'read_only') =>
    world.inTenant((tx) =>
      status === 'read_only'
        ? tx.execute(
            sql`UPDATE tenant SET status = 'read_only', read_only_since = now() WHERE id = ${world.tenant.id}`,
          )
        : tx.execute(
            sql`UPDATE tenant SET status = 'active', read_only_since = NULL WHERE id = ${world.tenant.id}`,
          ),
    );

  async function pages(visitor: Visitor, slug: string, professional: string) {
    return {
      page: shapeOf(await visitor.get(pageOf(slug))),
      professional: shapeOf(await visitor.get(professionalOf(slug, professional))),
      availability: shapeOf(await visitor.get(availabilityOf(slug, professional))),
    };
  }

  it('answers the same whether it never existed, was disabled, was regenerated or the organization is read-only', async () => {
    const visitor = world.visitor();
    const never = await pages(visitor, 'zzzzzzzzzzzz', 'yyyyyyyyyyyy');

    // The link of the organization is disabled.
    const owner = links.organization;
    await world.api.patch(`/booking-links/${owner.id}`, world.owner, { enabled: false });
    const disabled = await pages(visitor, owner.slug, links.professional.slug);
    await world.api.patch(`/booking-links/${owner.id}`, world.owner, { enabled: true });

    // The organization became read-only.
    await setStatus('read_only');
    const readOnly = await pages(visitor, owner.slug, links.professional.slug);
    await setStatus('active');

    // The link of the professional was regenerated: the old address stops resolving.
    const old = links.professional.slug;
    const regenerated = await world.api.post(
      `/booking-links/${links.professional.id}/regenerate`,
      world.owner,
      {},
    );
    expect(regenerated.statusCode, regenerated.body).toBeLessThan(300);
    const replaced = await pages(visitor, owner.slug, old);

    for (const answer of [disabled, readOnly]) expect(answer.page).toBe(never.page);
    expect(readOnly.professional).toBe(never.professional);
    expect(replaced.professional).toBe(never.professional);
    expect(replaced.availability).toBe(never.availability);
    const live = await world.api.get('/booking-links', world.owner);
    links = {
      organization: links.organization,
      professional:
        live
          .json<{ links: (typeof links.professional)[] }>()
          .links.find((link) => link.id === links.professional.id) ?? links.professional,
    };
  });

  it('does not take a hold or a form in a read-only organization, and says nothing of why', async () => {
    const visitor = world.visitor();
    const body = {
      professional: links.professional.slug,
      locationId: world.centro,
      appointmentTypeId: world.consulta,
      startsAt: `${world.monday(60)}T13:00:00.000Z`,
    };
    const unknown = await visitor.post('/public/zzzzzzzzzzzz/booking/holds', {
      ...body,
      challengeProof: await visitor.solve(),
    });

    await setStatus('read_only');
    let readOnly: Awaited<ReturnType<Visitor['post']>>;
    try {
      readOnly = await visitor.post(`/public/${links.organization.slug}/booking/holds`, {
        ...body,
        challengeProof: await visitor.solve(),
      });
    } finally {
      await setStatus('active');
    }

    expect(readOnly.statusCode).toBe(unknown.statusCode);
    expect(shapeOf(readOnly)).toBe(shapeOf(unknown));
  });
});
