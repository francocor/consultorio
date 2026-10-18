import { randomUUID } from 'node:crypto';

import type {
  AppointmentStatus,
  OperationalReportResponse,
  Problem,
  ReportOptionsResponse,
  ReportRecordsResponse,
} from '@consultorio/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { appointment, appointmentEvent } from '../../src/db/schema/scheduling.js';
import { waitlistEntry, waitlistOffer } from '../../src/db/schema/waitlist.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';
import { createSchedulingWorld, insertAppointment } from '../support/scheduling.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let world: SchedulingHttpWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createSchedulingHttpWorld(runtime, { slug: 'op-report' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const BUENOS_AIRES = '-03:00';

interface Seed {
  /** `YYYY-MM-DD` at the location, and the hour of the day (the minute is always :00 or :30). */
  day: string;
  slot: number;
  status?: AppointmentStatus;
  source?: 'staff' | 'online' | 'waitlist_offer';
  professionalId?: string;
  locationId?: string;
  patientId?: string;
  offset?: string;
}

/** The 30 minute slot `slot` of the day, from 08:00 local time. */
function instantOf(seed: Pick<Seed, 'day' | 'slot' | 'offset'>): Date {
  const minutes = 8 * 60 + seed.slot * 30;
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return new Date(`${seed.day}T${hh}:${mm}:00${seed.offset ?? BUENOS_AIRES}`);
}

async function seed(rows: readonly Seed[]): Promise<string[]> {
  const patientId = await world.freshPatient();
  return world.inTenant(async (tx) => {
    const ids: string[] = [];
    for (const row of rows) {
      const start = instantOf(row);
      const [created] = await tx
        .insert(appointment)
        .values({
          tenantId: world.tenant.id,
          patientId: row.patientId ?? patientId,
          professionalId: row.professionalId ?? world.doctor.professionalId,
          locationId: row.locationId ?? world.centro,
          appointmentTypeId: world.consulta,
          startsAt: start,
          endsAt: new Date(start.getTime() + 30 * 60_000),
          status: row.status ?? 'attended',
          source: row.source ?? 'staff',
          bookedBy: randomUUID(),
        })
        .returning({ id: appointment.id });
      if (!created) throw new Error('no appointment');
      ids.push(created.id);
    }
    return ids;
  });
}

/** `count` appointments of one status, one slot each, from a given first slot of a month. */
function bulk(
  count: number,
  status: AppointmentStatus,
  month: string,
  firstSlot: number,
  extra: Partial<Seed> = {},
): Seed[] {
  return Array.from({ length: count }, (_, index) => {
    const slot = firstSlot + index;
    return {
      day: `${month}-${String(1 + Math.floor(slot / 16)).padStart(2, '0')}`,
      slot: slot % 16,
      status,
      ...extra,
    };
  });
}

async function addEvents(
  appointmentIds: readonly string[],
  event: {
    kind: 'rescheduled' | 'status_changed';
    toStatus?: string;
    actorKind?: 'staff' | 'patient' | 'system';
  },
) {
  await world.inTenant((tx) =>
    tx.insert(appointmentEvent).values(
      appointmentIds.map((appointmentId) => ({
        tenantId: world.tenant.id,
        appointmentId,
        kind: event.kind,
        toStatus: event.toStatus ?? null,
        actorKind: event.actorKind ?? 'staff',
      })),
    ),
  );
}

const query = (filters: Record<string, string>) => `?${new URLSearchParams(filters).toString()}`;

async function operational(
  session: Parameters<typeof world.api.get>[1],
  filters: Record<string, string>,
) {
  const response = await world.api.get(`/reports/operational${query(filters)}`, session);
  return { response, body: response.json<OperationalReportResponse>() };
}

async function records(
  session: Parameters<typeof world.api.get>[1],
  filters: Record<string, string>,
) {
  const response = await world.api.get(`/reports/operational/records${query(filters)}`, session);
  return { response, body: response.json<ReportRecordsResponse>() };
}

async function auditRows(action: string) {
  return world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action as never)))
      .orderBy(asc(auditEvent.occurredAt)),
  );
}

describe('the operational numbers of a month (the spec scenarios)', () => {
  const MAY = { from: '2024-05-01', to: '2024-05-31' };
  let attended: string[];

  beforeAll(async () => {
    attended = await seed(bulk(88, 'attended', '2024-05', 0));
    await seed(bulk(12, 'no_show', '2024-05', 88));
    await seed(bulk(30, 'cancelled', '2024-05', 100));
    await seed(bulk(5, 'scheduled', '2024-05', 130));
    await addEvents(attended.slice(0, 10), { kind: 'rescheduled' });
  }, 60_000);

  it('shows a no-show rate of 12% for 88 attended and 12 no-show appointments', async () => {
    const { response, body } = await operational(world.admin, MAY);

    expect(response.statusCode, response.body).toBe(200);
    expect(body.noShow).toMatchObject({ attended: 88, noShow: 12, rateBp: 1200 });
  });

  it('keeps the rate at 12% with 30 cancellations in the month, and counts them apart', async () => {
    const { body } = await operational(world.admin, MAY);

    expect(body.noShow.rateBp).toBe(1200);
    expect(body.noShow.excluded.cancelled).toBe(30);
    expect(body.byStatus.cancelled).toBe(30);
    expect(body.totalAppointments).toBe(135);
  });

  it('counts the moved appointments as attended and shows the rescheduled figure derived from history', async () => {
    const { body } = await operational(world.admin, MAY);

    expect(body.byStatus.attended).toBe(88);
    expect(body.rescheduled).toBe(10);
  });

  it('leaves the appointments still open in the past out of the rate, and says how many', async () => {
    const { body } = await operational(world.admin, MAY);

    expect(body.byStatus.scheduled).toBe(5);
    expect(body.noShow.excluded).toMatchObject({ notFinal: 5, notFinalPast: 5 });
  });

  it('does not count a future appointment as one that is late for a status', async () => {
    await seed([
      { day: '2031-05-12', slot: 0, status: 'scheduled' },
      { day: '2031-05-12', slot: 1, status: 'confirmed' },
    ]);

    const { body } = await operational(world.admin, { from: '2031-05-01', to: '2031-05-31' });

    expect(body.noShow.excluded).toMatchObject({ notFinal: 2, notFinalPast: 0 });
    expect(body.noShow.rateBp).toBeNull();
  });

  it('has the breakdowns add up to the total', async () => {
    const { body } = await operational(world.admin, MAY);

    const sum = (rows: { total: number }[]) => rows.reduce((total, row) => total + row.total, 0);
    expect(sum(body.byDay)).toBe(135);
    expect(sum(body.byLocation)).toBe(135);
    expect(sum(body.byProfessional)).toBe(135);
    expect(body.byLocation[0]).toMatchObject({ name: 'Centro', noShow: 12, attended: 88 });
    expect(body.byDay.map((row) => row.date)).toEqual(
      [...body.byDay.map((row) => row.date)].sort(),
    );
  });

  it('has an empty period report nothing, and no rate', async () => {
    const { response, body } = await operational(world.admin, {
      from: '2020-01-01',
      to: '2020-01-31',
    });

    expect(response.statusCode).toBe(200);
    expect(body.totalAppointments).toBe(0);
    expect(body.noShow.rateBp).toBeNull();
    expect(body.byDay).toEqual([]);
  });
});

describe('date ranges are read in the time zone of each location', () => {
  it('puts 23:30 of the last day in the month at Buenos Aires, although it is already the next day in UTC', async () => {
    await seed([
      { day: '2024-02-29', slot: 31, status: 'attended' },
      { day: '2024-03-01', slot: 1, status: 'attended' },
    ]);

    const february = await operational(world.admin, { from: '2024-02-01', to: '2024-02-29' });
    const march = await operational(world.admin, { from: '2024-03-01', to: '2024-03-31' });

    expect(february.body.totalAppointments).toBe(1);
    expect(february.body.byDay.map((row) => row.date)).toEqual(['2024-02-29']);
    expect(march.body.totalAppointments).toBe(1);
    expect(march.body.byDay.map((row) => row.date)).toEqual(['2024-03-01']);
  });

  it('reads the day of a location in another zone at that zone', async () => {
    const created = await world.api.post('/locations', world.owner, {
      name: 'Auckland',
      timeZone: 'Pacific/Auckland',
    });
    expect(created.statusCode, created.body).toBe(201);
    const auckland = created.json<{ id: string }>().id;
    // 2024-08-01 08:00 in Auckland (+12:00 in winter) is still 31 July in UTC and in Buenos Aires.
    await seed([{ day: '2024-08-01', slot: 0, locationId: auckland, offset: '+12:00' }]);

    const july = await operational(world.admin, { from: '2024-07-01', to: '2024-07-31' });
    const august = await operational(world.admin, { from: '2024-08-01', to: '2024-08-31' });

    expect(july.body.totalAppointments).toBe(0);
    expect(august.body.totalAppointments).toBe(1);
    expect(august.body.byDay[0]?.date).toBe('2024-08-01');
  });
});

describe('what each role is allowed to read', () => {
  const JULY = { from: '2024-07-01', to: '2024-07-31' };

  beforeAll(async () => {
    await seed([
      {
        day: '2024-07-02',
        slot: 0,
        professionalId: world.doctor.professionalId,
        locationId: world.centro,
      },
      {
        day: '2024-07-02',
        slot: 1,
        professionalId: world.colleague.professionalId,
        locationId: world.centro,
      },
      {
        day: '2024-07-02',
        slot: 2,
        professionalId: world.doctor.professionalId,
        locationId: world.norte,
      },
      {
        day: '2024-07-02',
        slot: 3,
        professionalId: world.colleague.professionalId,
        locationId: world.norte,
      },
    ]);
  }, 60_000);

  it('gives the owner and the admin the whole organization', async () => {
    const owner = await operational(world.owner, JULY);
    const admin = await operational(world.admin, JULY);

    expect(owner.body.totalAppointments).toBe(4);
    expect(admin.body.totalAppointments).toBe(4);
    expect(owner.body.filters.scope).toBe('organization');
  });

  it('gives a professional their own appointments at every location, and nobody else’s', async () => {
    const { response, body } = await operational(world.doctor, JULY);

    expect(response.statusCode).toBe(200);
    expect(body.filters.scope).toBe('professional');
    expect(body.totalAppointments).toBe(2);
    expect(body.byProfessional.map((row) => row.professionalId)).toEqual([
      world.doctor.professionalId,
    ]);
  });

  it('gives reception the locations it works at, whoever the professional is', async () => {
    const { body } = await operational(world.reception, JULY);

    expect(body.filters.scope).toBe('locations');
    expect(body.totalAppointments).toBe(2);
    expect(body.byLocation.map((row) => row.locationId)).toEqual([world.centro]);
    expect(body.byProfessional).toHaveLength(2);
  });

  it('refuses, and audits, a professional who asks for a colleague', async () => {
    const before = (await auditRows('access.denied')).length;

    const { response, body } = await operational(world.doctor, {
      ...JULY,
      professionalId: world.colleague.professionalId,
    });

    expect(response.statusCode).toBe(403);
    expect((body as unknown as Problem).code).toBe('forbidden');
    expect((await auditRows('access.denied')).length).toBe(before + 1);
  });

  it('refuses reception a location it does not work at, and lets it narrow inside its own', async () => {
    const outside = await operational(world.reception, { ...JULY, locationId: world.norte });
    const inside = await operational(world.reception, { ...JULY, locationId: world.centro });
    const narrowed = await operational(world.reception, {
      ...JULY,
      professionalId: world.colleague.professionalId,
    });

    expect(outside.response.statusCode).toBe(403);
    expect(inside.body.totalAppointments).toBe(2);
    expect(narrowed.body.totalAppointments).toBe(1);
  });

  it('answers 401 to nobody and refuses the drill-down the same way as the report', async () => {
    const anonymous = await world.api.get(`/reports/operational${query(JULY)}`, null);
    const outside = await records(world.reception, { ...JULY, locationId: world.norte });

    expect(anonymous.statusCode).toBe(401);
    expect(outside.response.statusCode).toBe(403);
  });

  it('narrows by professional and by specialty', async () => {
    await world.inTenant(async (tx) => {
      await tx.execute(
        sql`UPDATE professional SET specialties = ARRAY['clinica']::text[] WHERE id = ${world.doctor.professionalId}`,
      );
      await tx.execute(
        sql`UPDATE professional SET specialties = ARRAY['pediatria']::text[] WHERE id = ${world.colleague.professionalId}`,
      );
    });

    const byProfessional = await operational(world.owner, {
      ...JULY,
      professionalId: world.colleague.professionalId,
    });
    const bySpecialty = await operational(world.owner, { ...JULY, specialty: 'clinica' });
    const all = await operational(world.owner, JULY);

    expect(byProfessional.body.totalAppointments).toBe(2);
    expect(bySpecialty.body.totalAppointments).toBe(2);
    expect(bySpecialty.body.byProfessional.map((row) => row.professionalId)).toEqual([
      world.doctor.professionalId,
    ]);
    expect(all.body.bySpecialty.map((row) => [row.specialty, row.total])).toEqual([
      ['clinica', 2],
      ['pediatria', 2],
    ]);
  });
});

describe('a request cannot widen the tenant or the range', () => {
  it('ignores the id of another organization in the query', async () => {
    const other = await createTestTenant(runtime, { slug: 'op-report-other' });
    const foreign = await createSchedulingWorld(runtime, other.id);
    await asTenant(runtime, other.id, (tx) =>
      insertAppointment(tx, foreign, {
        start: new Date('2024-09-10T13:00:00.000Z'),
        status: 'attended',
      }),
    );
    await seed([{ day: '2024-09-10', slot: 0 }]);

    const { body } = await operational(world.owner, {
      from: '2024-09-01',
      to: '2024-09-30',
      tenantId: other.id,
      tenant_id: other.id,
    });

    expect(body.totalAppointments).toBe(1);
  });

  it('refuses an inverted range with a message on the field, and does not run the report', async () => {
    const { response, body } = await operational(world.owner, {
      from: '2024-05-31',
      to: '2024-05-01',
    });

    const problem = body as unknown as Problem;
    expect(response.statusCode).toBe(400);
    expect(problem.code).toBe('validation_failed');
    expect(problem.errors).toEqual([{ path: 'to', i18nKey: 'reports.range.inverted' }]);
  });

  it('refuses a span of more than 366 days', async () => {
    const { response, body } = await operational(world.owner, {
      from: '2024-01-01',
      to: '2025-01-02',
    });

    expect(response.statusCode).toBe(400);
    expect((body as unknown as Problem).errors).toEqual([
      { path: 'to', i18nKey: 'reports.range.too_long' },
    ]);
  });
});

describe('occupancy comes from the working hours of the period', () => {
  // 2024-04-01 is a Monday: both professionals work 09:00 to 13:00 at Centro (240 minutes each).
  const WEEK = { from: '2024-04-01', to: '2024-04-07' };

  beforeAll(async () => {
    await seed([
      { day: '2024-04-01', slot: 2, status: 'attended' },
      { day: '2024-04-01', slot: 3, status: 'scheduled' },
      { day: '2024-04-01', slot: 4, status: 'cancelled' },
    ]);
  }, 60_000);

  it('divides the booked minutes by the working minutes of the professional', async () => {
    const week = await operational(world.doctor, WEEK);
    const monday = await operational(world.doctor, { from: '2024-04-01', to: '2024-04-01' });
    expect(monday.body.occupancy).toEqual({
      bookedMinutes: 60,
      availableMinutes: 240,
      rateBp: 2500,
    });
    expect(week.body.occupancy.availableMinutes).toBe(240);
  });

  it('adds the hours of every professional for the organization, and has no occupancy on a day nobody works', async () => {
    const organization = await operational(world.owner, { from: '2024-04-01', to: '2024-04-01' });
    const tuesday = await operational(world.owner, { from: '2024-04-02', to: '2024-04-02' });

    expect(organization.body.occupancy).toEqual({
      bookedMinutes: 60,
      availableMinutes: 480,
      rateBp: 1250,
    });
    expect(tuesday.body.occupancy).toEqual({ bookedMinutes: 0, availableMinutes: 0, rateBp: null });
  });

  it('takes a block out of the available time', async () => {
    const block = await world.api.post('/schedule-blocks', world.owner, {
      professionalId: world.doctor.professionalId,
      startsAt: '2024-04-08T12:00:00.000Z',
      endsAt: '2024-04-08T14:00:00.000Z',
      reason: 'course',
    });
    expect(block.statusCode, block.body).toBe(201);

    const { body } = await operational(world.doctor, { from: '2024-04-08', to: '2024-04-08' });

    // 09:00 to 13:00 in Buenos Aires is 12:00 to 16:00 UTC: the block takes the first two hours.
    expect(body.occupancy.availableMinutes).toBe(120);
  });
});

describe('patients, sources, confirmations and recovered slots', () => {
  const OCTOBER = { from: '2024-10-01', to: '2024-10-31' };

  it('tells new patients from returning ones by their earlier appointments', async () => {
    const returning = await world.freshPatient();
    const brandNew = await world.freshPatient();
    const cancelledBefore = await world.freshPatient();
    await seed([
      { day: '2024-09-03', slot: 0, patientId: returning, status: 'attended' },
      { day: '2024-09-03', slot: 1, patientId: cancelledBefore, status: 'cancelled' },
      { day: '2024-10-03', slot: 0, patientId: returning },
      { day: '2024-10-03', slot: 1, patientId: returning },
      { day: '2024-10-03', slot: 2, patientId: brandNew },
      { day: '2024-10-03', slot: 3, patientId: cancelledBefore },
    ]);

    const { body } = await operational(world.owner, OCTOBER);

    expect(body.patients).toEqual({ new: 2, returning: 1 });
  });

  it('shows the share of appointments booked online', async () => {
    await seed([
      { day: '2024-11-05', slot: 0, source: 'online' },
      { day: '2024-11-05', slot: 1, source: 'staff' },
      { day: '2024-11-05', slot: 2, source: 'staff' },
      { day: '2024-11-05', slot: 3, source: 'online' },
    ]);

    const { body } = await operational(world.owner, { from: '2024-11-01', to: '2024-11-30' });

    expect(body.sources).toEqual({ staff: 2, online: 2, waitlistOffer: 0, onlineShareBp: 5000 });
  });

  it('counts the appointments a patient confirmed, from the history', async () => {
    const ids = await seed(bulk(4, 'confirmed', '2024-12', 0));
    await addEvents(ids.slice(0, 2), {
      kind: 'status_changed',
      toStatus: 'confirmed',
      actorKind: 'patient',
    });
    await addEvents(ids.slice(2, 3), {
      kind: 'status_changed',
      toStatus: 'confirmed',
      actorKind: 'staff',
    });

    const { body } = await operational(world.owner, { from: '2024-12-01', to: '2024-12-31' });

    expect(body.confirmations).toEqual({ confirmedByPatient: 2, rateBp: 5000 });
  });

  it('counts the slots recovered through accepted waitlist offers, and lists them in the drill-down', async () => {
    const [recovered, other] = await seed([
      { day: '2025-01-07', slot: 0, source: 'waitlist_offer', status: 'scheduled' },
      { day: '2025-01-07', slot: 1, source: 'staff', status: 'scheduled' },
    ]);
    const patientId = await world.freshPatient();
    await world.inTenant(async (tx) => {
      const [entry] = await tx
        .insert(waitlistEntry)
        .values({
          tenantId: world.tenant.id,
          patientId,
          appointmentTypeId: world.consulta,
          expiresAt: new Date('2025-06-01T00:00:00Z'),
          status: 'closed',
          closeReason: 'fulfilled',
          closedAt: new Date('2025-01-02T00:00:00Z'),
        })
        .returning({ id: waitlistEntry.id });
      const startsAt = instantOf({ day: '2025-01-07', slot: 0 });
      await tx.insert(waitlistOffer).values({
        tenantId: world.tenant.id,
        entryId: entry?.id ?? '',
        patientId,
        slotKey: `slot-${randomUUID()}`,
        professionalId: world.doctor.professionalId,
        locationId: world.centro,
        appointmentTypeId: world.consulta,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        freedStartsAt: startsAt,
        freedEndsAt: new Date(startsAt.getTime() + 30 * 60_000),
        status: 'accepted',
        sendAt: new Date('2025-01-02T00:00:00Z'),
        expiresAt: new Date('2025-01-03T00:00:00Z'),
        closedAt: new Date('2025-01-02T10:00:00Z'),
        appointmentId: recovered ?? null,
      });
    });
    const period = { from: '2025-01-01', to: '2025-01-31' };

    const { body } = await operational(world.owner, period);
    const listed = await records(world.owner, { ...period, group: 'recovered' });

    expect(other).toBeDefined();
    expect(body.waitlist.recoveredSlots).toBe(1);
    expect(listed.body.total).toBe(1);
    expect(listed.body.records.map((row) => row.appointmentId)).toEqual([recovered]);
  });
});

describe('the drill-down', () => {
  const MAY = { from: '2024-05-01', to: '2024-05-31' };

  it('lists the records of a group, and the group sizes add up to the total of the report', async () => {
    const report = await operational(world.admin, MAY);
    const noShows = await records(world.admin, { ...MAY, group: 'no_show', limit: '200' });
    const all = await records(world.admin, { ...MAY, group: 'all', limit: '1' });

    expect(noShows.response.statusCode, noShows.response.body).toBe(200);
    expect(noShows.body.total).toBe(12);
    expect(noShows.body.records).toHaveLength(12);
    expect(noShows.body.records.every((row) => row.status === 'no_show')).toBe(true);
    expect(all.body.total).toBe(report.body.totalAppointments);

    let sum = 0;
    for (const status of Object.keys(report.body.byStatus)) {
      const group = await records(world.admin, { ...MAY, group: status, limit: '1' });
      sum += group.body.total;
    }
    expect(sum).toBe(report.body.totalAppointments);
  });

  it('lists the rescheduled appointments, derived from history', async () => {
    const rescheduled = await records(world.admin, { ...MAY, group: 'rescheduled', limit: '50' });

    expect(rescheduled.body.total).toBe(10);
    expect(rescheduled.body.records.every((row) => row.rescheduled)).toBe(true);
  });

  it('pages in order of time without repeating or skipping a row', async () => {
    const first = await records(world.admin, {
      ...MAY,
      group: 'attended',
      limit: '5',
      offset: '0',
    });
    const second = await records(world.admin, {
      ...MAY,
      group: 'attended',
      limit: '5',
      offset: '5',
    });

    const ids = [...first.body.records, ...second.body.records].map((row) => row.appointmentId);
    const times = [...first.body.records, ...second.body.records].map((row) => row.startsAt);
    expect(new Set(ids).size).toBe(10);
    expect(times).toEqual([...times].sort());
    expect(first.body).toMatchObject({ total: 88, limit: 5, offset: 0 });
    expect(second.body.offset).toBe(5);
  });

  it('has administrative columns and the identification of the patient, and nothing clinical', async () => {
    const { body } = await records(world.admin, { ...MAY, group: 'no_show', limit: '1' });

    const [row] = body.records;
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'appointmentId',
        'appointmentTypeName',
        'localDate',
        'locationId',
        'locationName',
        'patientId',
        'patientName',
        'professionalId',
        'professionalName',
        'rescheduled',
        'source',
        'startsAt',
        'status',
      ].sort(),
    );
    expect(row?.patientName).toMatch(/^Paciente\d+, Nombre$/);
    expect(row?.locationName).toBe('Centro');
  });

  it('records the access to patient-level rows, with the filters and the number of rows, and not the aggregate report', async () => {
    const before = (await auditRows('report.accessed')).length;
    await operational(world.admin, MAY);
    const afterAggregate = (await auditRows('report.accessed')).length;

    const { response } = await records(world.admin, { ...MAY, group: 'no_show', limit: '10' });
    const rows = await auditRows('report.accessed');

    expect(response.statusCode).toBe(200);
    expect(afterAggregate).toBe(before);
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)).toMatchObject({
      outcome: 'allow',
      resourceType: 'report',
      actorUserId: world.admin.user.id,
    });
    expect(rows.at(-1)?.metadata).toMatchObject({
      report: 'operational.records',
      group: 'no_show',
      from: '2024-05-01',
      to: '2024-05-31',
      rows: 10,
    });
  });

  it('scopes the rows like the report: a professional sees only their own patients’ rows', async () => {
    const own = await records(world.doctor, { from: '2024-07-01', to: '2024-07-31', limit: '50' });

    expect(own.body.total).toBe(2);
    expect(
      own.body.records.every((row) => row.professionalId === world.doctor.professionalId),
    ).toBe(true);
  });
});

describe('the options a screen offers', () => {
  beforeAll(async () => {
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE professional SET specialties = ARRAY['clinica']::text[] WHERE id = ${world.doctor.professionalId}`,
      ),
    );
  });

  it('lists every location and professional to the owner, and whether revenue by professional is theirs', async () => {
    const response = await world.api.get('/reports/options', world.owner);
    const body = response.json<ReportOptionsResponse>();

    expect(response.statusCode, response.body).toBe(200);
    expect(body.scope).toBe('organization');
    expect(body.locations.map((row) => row.name)).toEqual(
      expect.arrayContaining(['Centro', 'Norte']),
    );
    expect(body.professionals.map((row) => row.id)).toEqual(
      expect.arrayContaining([world.doctor.professionalId, world.colleague.professionalId]),
    );
    expect(body.canSeeRevenueByProfessional).toBe(true);
    expect(body.maxSpanDays).toBe(366);
  });

  it('lists only its own locations to reception, and never revenue by professional', async () => {
    const response = await world.api.get('/reports/options', world.reception);
    const body = response.json<ReportOptionsResponse>();

    expect(body.scope).toBe('locations');
    expect(body.locations.map((row) => row.id)).toEqual([world.centro]);
    expect(body.canSeeRevenueByProfessional).toBe(false);
  });

  it('lists only themselves to a professional', async () => {
    const response = await world.api.get('/reports/options', world.doctor);
    const body = response.json<ReportOptionsResponse>();

    expect(body.scope).toBe('professional');
    expect(body.professionals.map((row) => row.id)).toEqual([world.doctor.professionalId]);
    expect(body.specialties).toEqual(['clinica']);
  });
});

describe('reports have no way to reach clinical content', () => {
  it('has no clinical field in any response of the module', async () => {
    const report = await world.api.get(
      `/reports/operational${query({ from: '2024-05-01', to: '2024-05-31' })}`,
      world.admin,
    );
    const drill = await world.api.get(
      `/reports/operational/records${query({ from: '2024-05-01', to: '2024-05-31', limit: '20' })}`,
      world.admin,
    );

    for (const response of [report, drill]) {
      expect(response.body).not.toMatch(/diagnos|prescri|note|evolution|anamnes|consent|clinical/i);
    }
  });
});
