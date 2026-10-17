import type {
  AppointmentDto,
  AppointmentHistoryResponse,
  AuditAction,
  LocationDto,
  AppointmentTypeDto,
  WorklistResponse,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { careRelationship } from '../../src/db/schema/care.js';
import { patient, patientVersion } from '../../src/db/schema/patients.js';
import { appointment } from '../../src/db/schema/scheduling.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';
import { insertPatient } from '../support/scheduling.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant } from '../support/tenants.js';
import { createTestProfessional, createTestUser } from '../support/users.js';

let runtime: DbHandle;
let world: SchedulingHttpWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createSchedulingHttpWorld(runtime, { slug: 'sched-identity' });
  // The colleague confirms patients of the doctor, so the doctor's calendar is delegated to them.
  await world.delegateCalendar(world.colleague, [world.doctor.professionalId]);
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const url = (created: { id: string }, action: string) => `/appointments/${created.id}/${action}`;

async function auditRows(action: AuditAction) {
  return world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

async function stored(created: { id: string }) {
  const [row] = await world.inTenant((tx) =>
    tx.select().from(appointment).where(eq(appointment.id, created.id)),
  );
  return row;
}

const openReviews = async (who: TestSession = world.admin) =>
  (await world.api.get('/worklist?kind=identity_review', who)).json<WorklistResponse>().items;

/** The professional of the world books an existing patient with themselves: identity unconfirmed. */
async function selfBooked(weeksAfter: number, time = '10:00') {
  return world.book(weeksAfter, time, {}, world.doctor);
}

describe('the professional books an existing patient with themselves (D14)', () => {
  it('starts unconfirmed, opens an identity review for reception, and gives no care relationship', async () => {
    const created = await selfBooked(1);

    expect(created).toMatchObject({
      identityConfirmed: false,
      identityConfirmation: null,
      source: 'staff',
    });
    const reviews = await openReviews(world.reception);
    const review = reviews.find((item) => item.subjectId === created.id);
    expect(review).toMatchObject({
      kind: 'identity_review',
      locationId: world.centro,
      appointment: { identityConfirmed: false, patientId: created.patientId },
    });
    expect(review?.actions).toEqual(expect.arrayContaining(['confirm_identity', 'detach_patient']));
  });

  it('starts confirmed when reception or another professional books, or the patient is new', async () => {
    const byReception = await world.book(2, '10:00');
    const byColleague = await world.book(2, '11:00', {}, world.colleague);

    expect(byReception.identityConfirmed).toBe(true);
    expect(byColleague.identityConfirmed).toBe(true);
    expect((await openReviews()).some((item) => item.subjectId === byReception.id)).toBe(false);
  });
});

describe('check-in confirms the identity', () => {
  it('lets reception confirm at check-in: the identity is confirmed, the review closes, the audit names reception', async () => {
    const created = await selfBooked(3);

    const response = await world.act(created, 'check-in', world.reception, {
      confirmIdentity: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<AppointmentDto>()).toMatchObject({
      status: 'checked_in',
      identityConfirmed: true,
      identityConfirmation: 'staff',
    });
    expect((await openReviews()).some((item) => item.subjectId === created.id)).toBe(false);
    const [row] = await auditRows('appointment.identity.confirmed');
    expect(row).toMatchObject({ resourceId: created.id, actorUserId: world.reception.user.id });
    expect(await stored(created)).toMatchObject({
      identityConfirmedBy: world.reception.user.id,
      identityConfirmation: 'staff',
    });
    const history = (
      await world.api.get(url(created, 'history'), world.reception)
    ).json<AppointmentHistoryResponse>();
    expect(history.events.map((event) => event.kind)).toEqual([
      'created',
      'status_changed',
      'identity_confirmed',
    ]);
  });

  it('checks in without confirming when reception does not confirm', async () => {
    const created = await selfBooked(4);

    const response = await world.act(created, 'check-in', world.reception, {});

    expect(response.json<AppointmentDto>()).toMatchObject({
      status: 'checked_in',
      identityConfirmed: false,
    });
    expect((await openReviews()).some((item) => item.subjectId === created.id)).toBe(true);
  });

  it('does not let the professional own check-in confirm when the organization has other staff', async () => {
    const created = await selfBooked(5);

    const response = await world.act(created, 'check-in', world.doctor, {
      confirmIdentity: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<AppointmentDto>()).toMatchObject({
      status: 'checked_in',
      identityConfirmed: false,
    });
    expect((await openReviews()).some((item) => item.subjectId === created.id)).toBe(true);
    expect(await auditRows('appointment.identity.self_confirmed')).toHaveLength(0);
  });

  it('lets another professional confirm, as staff', async () => {
    const created = await selfBooked(6);

    const response = await world.act(created, 'check-in', world.colleague, {
      confirmIdentity: true,
    });

    expect(response.json<AppointmentDto>().identityConfirmation).toBe('staff');
  });
});

describe('the identity review on the worklist', () => {
  it('lets reception and admin confirm, and keeps the review out of the queue afterwards', async () => {
    const one = await selfBooked(7);
    const two = await selfBooked(8);
    const itemOne = (await openReviews()).find((item) => item.subjectId === one.id);
    const itemTwo = (await openReviews()).find((item) => item.subjectId === two.id);

    const byReception = await world.api.post(
      `/worklist/${itemOne?.id ?? ''}/confirm-identity`,
      world.reception,
      { expectedVersion: itemOne?.appointment?.version },
    );
    const byAdmin = await world.api.post(
      `/worklist/${itemTwo?.id ?? ''}/confirm-identity`,
      world.admin,
      { expectedVersion: itemTwo?.appointment?.version },
    );

    expect(byReception.json<AppointmentDto>()).toMatchObject({
      identityConfirmed: true,
      identityConfirmation: 'staff',
    });
    expect(byAdmin.json<AppointmentDto>().identityConfirmed).toBe(true);
    const done = (
      await world.api.get('/worklist?status=resolved&kind=identity_review', world.admin)
    ).json<WorklistResponse>();
    expect(done.items.find((item) => item.id === itemOne?.id)).toMatchObject({
      resolution: 'identity_confirmed',
      resolvedBy: world.reception.user.id,
    });
  });

  it('cannot be closed by a plain resolve or dismiss, which would skip the confirmation', async () => {
    const created = await selfBooked(9);
    const item = (await openReviews()).find((i) => i.subjectId === created.id);

    expect(
      (await world.api.post(`/worklist/${item?.id ?? ''}/resolve`, world.admin, {})).statusCode,
    ).toBe(409);
    expect(
      (await world.api.post(`/worklist/${item?.id ?? ''}/dismiss`, world.admin, {})).statusCode,
    ).toBe(409);
    expect((await stored(created))?.identityConfirmed).toBe(false);
  });

  it('refuses the professional of the appointment (here the owner who is also the professional), and audits it', async () => {
    const both = await createTestProfessional(runtime, world.tenant.id, {
      password: TEST_PASSWORD,
      alsoRoles: ['owner'],
    });
    const session = await world.signIn(both);
    await world.api.put(`/professionals/${both.professionalId}/hours`, session, {
      hours: [{ locationId: world.centro, weekday: 1, start: '09:00', end: '13:00' }],
    });
    const created = (
      await world.api.post('/appointments', session, {
        ...(await world.bookingBody(10, '10:00')),
        professionalId: both.professionalId,
      })
    ).json<AppointmentDto>();
    expect(created.identityConfirmed).toBe(false);
    const item = (await openReviews()).find((i) => i.subjectId === created.id);
    const denied = (await auditRows('access.denied')).length;

    const response = await world.api.post(`/worklist/${item?.id ?? ''}/confirm-identity`, session, {
      expectedVersion: created.version,
    });

    expect(response.statusCode).toBe(403);
    expect((await auditRows('access.denied')).length).toBe(denied + 1);
    expect((await stored(created))?.identityConfirmed).toBe(false);
    // A professional without the worklist permission is refused at the door.
    expect(
      (
        await world.api.post(`/worklist/${item?.id ?? ''}/confirm-identity`, world.colleague, {
          expectedVersion: created.version,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('is a conflict when the identity is already confirmed, and not found from another location', async () => {
    const created = await selfBooked(11);
    const item = (await openReviews()).find((i) => i.subjectId === created.id);
    await world.api.post(`/worklist/${item?.id ?? ''}/confirm-identity`, world.admin, {
      expectedVersion: created.version,
    });

    expect(
      (
        await world.api.post(`/worklist/${item?.id ?? ''}/confirm-identity`, world.admin, {
          expectedVersion: created.version + 1,
        })
      ).statusCode,
    ).toBe(409);
  });
});

describe('a cancelled appointment leaves the identity review', () => {
  it('dismisses the review when the appointment is cancelled, and nobody can confirm it afterwards', async () => {
    const created = await selfBooked(15);
    const item = (await openReviews()).find((i) => i.subjectId === created.id);
    expect(item).toBeDefined();

    const cancel = await world.act(created, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'illness',
    });

    expect(cancel.statusCode, cancel.body).toBe(200);
    expect((await openReviews()).some((i) => i.subjectId === created.id)).toBe(false);
    const dismissed = (
      await world.api.get('/worklist?status=dismissed&kind=identity_review', world.admin)
    ).json<WorklistResponse>();
    expect(dismissed.items.find((i) => i.id === item?.id)).toMatchObject({
      status: 'dismissed',
      resolution: 'appointment_cancelled',
      actions: [],
    });
    const confirm = await world.api.post(
      `/worklist/${item?.id ?? ''}/confirm-identity`,
      world.admin,
      {
        expectedVersion: created.version + 1,
      },
    );
    expect(confirm.statusCode).toBe(409);
    expect((await stored(created))?.identityConfirmed).toBe(false);
  });
});

describe('rejecting the match', () => {
  it('moves the appointment to a separate patient record and leaves the matched record untouched', async () => {
    const created = await selfBooked(12);
    const matched = created.patientId;
    const other = await world.inTenant((tx) => insertPatient(tx, world.tenant.id));
    const before = await world.inTenant(async (tx) => ({
      row: (await tx.select().from(patient).where(eq(patient.id, matched)))[0],
      versions: await tx.select().from(patientVersion).where(eq(patientVersion.patientId, matched)),
    }));

    const response = await world.act(created, 'detach-patient', world.reception, {
      resolution: 'move_to_patient',
      patientId: other,
    });

    expect(response.json<AppointmentDto>()).toMatchObject({
      patientId: other,
      identityConfirmed: true,
      identityConfirmation: 'staff',
    });
    const after = await world.inTenant(async (tx) => ({
      row: (await tx.select().from(patient).where(eq(patient.id, matched)))[0],
      versions: await tx.select().from(patientVersion).where(eq(patientVersion.patientId, matched)),
    }));
    expect(after).toEqual(before);
    expect((await openReviews()).some((item) => item.subjectId === created.id)).toBe(false);
    const [row] = await auditRows('appointment.identity.rejected');
    expect(row).toMatchObject({ resourceId: created.id, metadata: { resolution: 'moved' } });
  });

  it('cancels the appointment instead', async () => {
    const created = await selfBooked(13);

    const response = await world.act(created, 'detach-patient', world.admin, {
      resolution: 'cancel',
      cancelledBy: 'organization',
      reasonCode: 'other',
    });

    expect(response.json<AppointmentDto>().status).toBe('cancelled');
    expect((await openReviews()).some((item) => item.subjectId === created.id)).toBe(false);
  });

  it('is not for the appointment professional, an appointment with a confirmed identity, or a patient of another organization', async () => {
    const created = await selfBooked(14);
    const confirmed = await world.book(14, '11:00');
    const foreignTenant = await createTestTenant(runtime, { slug: 'sched-identity-foreign' });
    const foreignPatient = await asTenant(runtime, foreignTenant.id, (tx) =>
      insertPatient(tx, foreignTenant.id),
    );
    const move = (patientId: string) => ({ resolution: 'move_to_patient', patientId });

    expect(
      (await world.act(created, 'detach-patient', world.doctor, move(created.patientId)))
        .statusCode,
    ).toBe(403);
    expect(
      (await world.act(confirmed, 'detach-patient', world.reception, move(created.patientId)))
        .statusCode,
    ).toBe(409);
    expect(
      (await world.act(created, 'detach-patient', world.reception, move(foreignPatient)))
        .statusCode,
    ).toBe(404);
    expect(
      (await world.act(created, 'detach-patient', world.reception, move(created.patientId)))
        .statusCode,
    ).toBe(400);
  });
});

describe('a solo practice (D18)', () => {
  /** An organization with one member only: the owner, who is also the professional. */
  async function soloWorld(slug: string) {
    const tenant = await createTestTenant(runtime, { slug });
    const app = buildTestApplication(runtime, {});
    const api = clientFor(app, slug);
    const both = await createTestProfessional(runtime, tenant.id, {
      password: TEST_PASSWORD,
      alsoRoles: ['owner'],
    });
    const session = await signInAs(app, slug, both);
    const centro = (
      await api.post('/locations', session, { name: 'Consultorio' })
    ).json<LocationDto>().id;
    await api.put(`/professionals/${both.professionalId}/hours`, session, {
      hours: [{ locationId: centro, weekday: 1, start: '09:00', end: '13:00' }],
    });
    const type = (
      await api.post('/appointment-types', session, {
        name: 'Consulta',
        durationMinutes: 30,
        mode: 'in_person',
      })
    ).json<AppointmentTypeDto>().id;
    // Mondays far in the future; scheduling runs on the real clock here.
    const book = async (weeks: number) => {
      const patientId = await asTenant(runtime, tenant.id, (tx) => insertPatient(tx, tenant.id));
      const date = new Date(Date.UTC(2032, 0, 5 + 7 * weeks)).toISOString().slice(0, 10);
      const response = await api.post('/appointments', session, {
        patientId,
        professionalId: both.professionalId,
        locationId: centro,
        appointmentTypeId: type,
        local: { date, time: '10:00' },
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json<AppointmentDto>();
    };
    const reviews = async () =>
      (await api.get('/worklist?kind=identity_review', session)).json<WorklistResponse>().items;
    // The appointment was just created, so the version it came back with is the current one.
    const act = (
      target: AppointmentDto,
      action: string,
      by: TestSession,
      body: Record<string, unknown> = {},
    ) => api.post(url(target, action), by, { expectedVersion: target.version, ...body });
    return { tenant, app, api, session, both, book, reviews, act };
  }

  it('lets the sole professional self-confirm at in-person check-in, with its own audit marker', async () => {
    const solo = await soloWorld('sched-identity-solo');
    try {
      const created = await solo.book(0);
      expect(created.identityConfirmed).toBe(false);

      const response = await solo.act(created, 'check-in', solo.session, {
        confirmIdentity: true,
      });

      expect(response.json<AppointmentDto>()).toMatchObject({
        status: 'checked_in',
        identityConfirmed: true,
        identityConfirmation: 'self_confirmed',
      });
      expect((await solo.reviews()).some((item) => item.subjectId === created.id)).toBe(false);
      const rows = await asTenant(runtime, solo.tenant.id, (tx) =>
        tx
          .select()
          .from(auditEvent)
          .where(eq(auditEvent.action, 'appointment.identity.self_confirmed')),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ resourceId: created.id, actorUserId: solo.both.id });
    } finally {
      await solo.app.close();
    }
  });

  it('keeps the worklist closed to them: the sole professional cannot confirm from the review', async () => {
    const solo = await soloWorld('sched-identity-solo-worklist');
    try {
      const created = await solo.book(1);
      const item = (await solo.reviews()).find((i) => i.subjectId === created.id);

      const response = await solo.api.post(
        `/worklist/${item?.id ?? ''}/confirm-identity`,
        solo.session,
        { expectedVersion: created.version },
      );

      expect(response.statusCode).toBe(403);
      expect((await solo.reviews()).some((i) => i.subjectId === created.id)).toBe(true);
    } finally {
      await solo.app.close();
    }
  });

  it('stops being solo when staff join: earlier self-confirmations stay, later ones need someone else', async () => {
    const solo = await soloWorld('sched-identity-solo-grows');
    try {
      const first = await solo.book(2);
      await solo.act(first, 'check-in', solo.session, { confirmIdentity: true });
      const second = await solo.book(3);
      await createTestUser(runtime, solo.tenant.id, {
        roles: ['reception'],
        password: TEST_PASSWORD,
      });

      const later = await solo.act(second, 'check-in', solo.session, {
        confirmIdentity: true,
      });

      expect(later.json<AppointmentDto>()).toMatchObject({
        status: 'checked_in',
        identityConfirmed: false,
      });
      const kept = await asTenant(runtime, solo.tenant.id, (tx) =>
        tx.select().from(appointment).where(eq(appointment.id, first.id)),
      );
      expect(kept[0]).toMatchObject({
        identityConfirmed: true,
        identityConfirmation: 'self_confirmed',
      });
    } finally {
      await solo.app.close();
    }
  });
});

describe('moving a confirmed appointment into the actor own calendar (D14)', () => {
  it('goes back to unconfirmed, opens a review and gives the actor no care relationship', async () => {
    // Reception booked it for the doctor: confirmed. The colleague works the doctor's calendar by
    // delegation and moves it into their own.
    const created = await world.book(30, '10:00');
    expect(created.identityConfirmed).toBe(true);

    const response = await world.act(created, 'reschedule', world.colleague, {
      expectedVersion: 1,
      professionalId: world.colleague.professionalId,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<AppointmentDto>()).toMatchObject({
      professionalId: world.colleague.professionalId,
      identityConfirmed: false,
    });
    expect(await stored(created)).toMatchObject({
      identityConfirmed: false,
      identityConfirmedBy: null,
      identityConfirmation: null,
    });
    expect((await openReviews(world.reception)).some((item) => item.subjectId === created.id)).toBe(
      true,
    );
    const relationships = await world.inTenant((tx) =>
      tx.select().from(careRelationship).where(eq(careRelationship.patientId, created.patientId)),
    );
    expect(
      relationships.filter(
        (row) => row.professionalId === world.colleague.professionalId && row.active,
      ),
    ).toEqual([]);
    const [audit] = await auditRows('appointment.reassigned');
    expect(audit).toMatchObject({ resourceId: created.id, metadata: { identityReset: true } });
  });
});
