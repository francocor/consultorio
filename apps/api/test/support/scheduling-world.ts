import { randomBytes } from 'node:crypto';

import type { AppointmentDto, AppointmentTypeDto, LocationDto } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';

import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { appointment } from '../../src/db/schema/scheduling.js';
import type { ApplicationOptions } from '../../src/main/application.js';
import { createTenantKeys, type TenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import type { DbHandle } from '../../src/platform/db/pool.js';
import type { Tx } from '../../src/platform/db/tenant-context.js';

import { buildTestApplication } from './app.js';
import { insertPatient } from './scheduling.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from './session.js';
import { asTenant, createTestTenant, type TestTenant } from './tenants.js';
import { createTestProfessional, createTestUser, type TestUser } from './users.js';

export type Member = TestSession & { membershipId: string };
export type Doctor = TestSession & { professionalId: string; membershipId: string };

/**
 * A running organization for the scheduling tests: an owner, an admin, a reception user who works
 * at Centro only, two professionals with Monday 09:00-13:00 at Centro, one location more, two
 * appointment types and a fixed clock. Every test of a file uses its own days, so the files and the
 * tests never collide.
 */
export interface SchedulingHttpWorld {
  runtime: DbHandle;
  app: FastifyInstance;
  api: ReturnType<typeof clientFor>;
  /** The same key service the application uses, with the organization's data key in place. */
  keys: TenantKeys;
  /** Runs work as the organization, straight on the database. */
  inTenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  tenant: TestTenant;
  slug: string;
  /** The clock of the application; `setNow` moves it. */
  now(): Date;
  setNow(date: Date): void;
  owner: Member;
  admin: Member;
  reception: Member;
  doctor: Doctor;
  colleague: Doctor;
  centro: string;
  norte: string;
  consulta: string;
  withBuffer: string;
  /** A new patient of the organization. */
  freshPatient(): Promise<string>;
  /** The Monday `weeksAfter` weeks after 2031-05-12 (a Monday), as `YYYY-MM-DD`. */
  monday(weeksAfter: number): string;
  /** A booking request on that Monday, for the first professional at Centro, local time. */
  bookingBody(
    weeksAfter: number,
    time: string,
    extra?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /** Books and expects 201. */
  book(
    weeksAfter: number,
    time: string,
    extra?: Record<string, unknown>,
    by?: TestSession,
  ): Promise<AppointmentDto>;
  /** The current version of an appointment, read straight from the database. */
  versionOf(appointmentId: string): Promise<number>;
  /**
   * Posts an action of an appointment (`check-in`, `cancel`, `detach-patient`...) naming its
   * current version, like a screen that has just loaded it. A version in `body` wins, so a test
   * can send a stale one.
   */
  act(
    target: { id: string },
    action: string,
    by: TestSession,
    body?: Record<string, unknown>,
  ): Promise<LightMyRequestResponse>;
  signIn(user: TestUser): Promise<Member>;
  /** The owner gives `member` the calendars of these professionals (delegated calendar). */
  delegateCalendar(member: Member, professionalIds: string[]): Promise<void>;
  /** The owner takes the delegation back. */
  revokeDelegation(member: Member): Promise<void>;
  /** The owner gives `member` a grantable permission without a scope. */
  grantPermission(member: Member, permission: string): Promise<void>;
  /** The owner takes that permission back. */
  revokePermission(member: Member, permission: string): Promise<void>;
  addProfessional(options?: { maxSimultaneous?: number }): Promise<Doctor>;
  close(): Promise<void>;
}

export async function createSchedulingHttpWorld(
  runtime: DbHandle,
  options: {
    slug: string;
    now?: Date;
    /** Shared by several organizations of one test that one application serves (default: its own). */
    keys?: TenantKeys;
    app?: Partial<ApplicationOptions>;
  },
): Promise<SchedulingHttpWorld> {
  let current = options.now ?? new Date('2031-05-05T12:00:00.000Z');
  const tenant = await createTestTenant(runtime, { slug: options.slug });
  // Only scheduling runs on the moving clock: sessions keep the real one, so they do not expire.
  const keys =
    options.keys ??
    createTenantKeys({
      kms: createLocalKeyManagement(randomBytes(32).toString('base64')),
    });
  await asTenant(runtime, tenant.id, (tx) => keys.ensureTenantKey(tx));
  const app = buildTestApplication(runtime, {
    schedulingClock: () => current,
    keys,
    ...options.app,
  });
  const api = clientFor(app, options.slug);

  const signIn = async (user: TestUser): Promise<Member> => ({
    ...(await signInAs(app, options.slug, user)),
    membershipId: user.membershipId,
  });
  const make = (roles: ('owner' | 'admin' | 'reception')[]) =>
    createTestUser(runtime, tenant.id, { roles, password: TEST_PASSWORD });

  const owner = await signIn(await make(['owner']));
  const admin = await signIn(await make(['admin']));
  const reception = await signIn(await make(['reception']));
  const centro = (await api.post('/locations', owner, { name: 'Centro' })).json<LocationDto>().id;
  const norte = (await api.post('/locations', owner, { name: 'Norte' })).json<LocationDto>().id;
  await api.put(`/members/${reception.membershipId}/locations`, owner, { locationIds: [centro] });

  const addProfessional = async (settings: { maxSimultaneous?: number } = {}): Promise<Doctor> => {
    const created = await createTestProfessional(runtime, tenant.id, { password: TEST_PASSWORD });
    const session = await signIn(created);
    if (settings.maxSimultaneous && settings.maxSimultaneous > 1) {
      await asTenant(runtime, tenant.id, (tx) =>
        tx.execute(
          sql`UPDATE professional SET max_simultaneous = ${settings.maxSimultaneous} WHERE id = ${created.professionalId}`,
        ),
      );
    }
    const hours = await api.put(`/professionals/${created.professionalId}/hours`, session, {
      hours: [{ locationId: centro, weekday: 1, start: '09:00', end: '13:00' }],
    });
    expect(hours.statusCode).toBe(200);
    return { ...session, professionalId: created.professionalId };
  };

  const doctor = await addProfessional();
  const colleague = await addProfessional();
  const consulta = (
    await api.post('/appointment-types', owner, {
      name: 'Consulta',
      durationMinutes: 30,
      mode: 'in_person',
    })
  ).json<AppointmentTypeDto>().id;
  const withBuffer = (
    await api.post('/appointment-types', owner, {
      name: 'Con preparacion',
      durationMinutes: 30,
      bufferMinutes: 10,
      mode: 'in_person',
    })
  ).json<AppointmentTypeDto>().id;

  const freshPatient = () => asTenant(runtime, tenant.id, (tx) => insertPatient(tx, tenant.id));
  const monday = (weeksAfter: number) =>
    new Date(Date.UTC(2031, 4, 12 + 7 * weeksAfter)).toISOString().slice(0, 10);
  const bookingBody = async (
    weeksAfter: number,
    time: string,
    extra: Record<string, unknown> = {},
  ) => ({
    patientId: await freshPatient(),
    professionalId: doctor.professionalId,
    locationId: centro,
    appointmentTypeId: consulta,
    local: { date: monday(weeksAfter), time },
    ...extra,
  });
  const book = async (
    weeksAfter: number,
    time: string,
    extra: Record<string, unknown> = {},
    by: TestSession = reception,
  ): Promise<AppointmentDto> => {
    const response: LightMyRequestResponse = await api.post(
      '/appointments',
      by,
      await bookingBody(weeksAfter, time, extra),
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<AppointmentDto>();
  };

  const versionOf = async (appointmentId: string): Promise<number> => {
    const [row] = await asTenant(runtime, tenant.id, (tx) =>
      tx
        .select({ version: appointment.version })
        .from(appointment)
        .where(eq(appointment.id, appointmentId)),
    );
    if (!row) throw new Error(`no appointment ${appointmentId}`);
    return row.version;
  };
  const act = async (
    target: { id: string },
    action: string,
    by: TestSession,
    body: Record<string, unknown> = {},
  ): Promise<LightMyRequestResponse> =>
    api.post(`/appointments/${target.id}/${action}`, by, {
      expectedVersion: await versionOf(target.id),
      ...body,
    });

  await app.ready();
  return {
    runtime,
    app,
    api,
    keys,
    inTenant: (fn) => asTenant(runtime, tenant.id, fn),
    tenant,
    slug: options.slug,
    now: () => current,
    setNow: (date) => {
      current = date;
    },
    owner,
    admin,
    reception,
    doctor,
    colleague,
    centro,
    norte,
    consulta,
    withBuffer,
    freshPatient,
    monday,
    bookingBody,
    book,
    versionOf,
    act,
    signIn,
    delegateCalendar: async (member, professionalIds) => {
      const response = await api.post(`/members/${member.membershipId}/grants`, owner, {
        permission: 'scheduling.delegated_calendar',
        scope: { professionalIds },
      });
      expect(response.statusCode, response.body).toBe(201);
    },
    revokeDelegation: async (member) => {
      const response = await api.delete(
        `/members/${member.membershipId}/grants/scheduling.delegated_calendar`,
        owner,
      );
      expect(response.statusCode, response.body).toBe(204);
    },
    grantPermission: async (member, permission) => {
      const response = await api.post(`/members/${member.membershipId}/grants`, owner, {
        permission,
      });
      expect(response.statusCode, response.body).toBe(201);
    },
    revokePermission: async (member, permission) => {
      const response = await api.delete(
        `/members/${member.membershipId}/grants/${permission}`,
        owner,
      );
      expect(response.statusCode, response.body).toBe(204);
    },
    addProfessional,
    close: () => app.close(),
  };
}
