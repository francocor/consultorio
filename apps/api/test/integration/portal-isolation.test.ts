import type {
  PortalAppointmentResponse,
  PortalAppointmentsResponse,
  PortalMeResponse,
  Problem,
} from '@consultorio/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createPortalWorld, rowsOf, type PortalWorld } from '../support/portal-world.js';

/**
 * What a signed-in patient sees (S5.08, tasks 5.31 to 5.34): only the subject of their session,
 * never somebody else's, and the portal says so in the trail when somebody asks for what is not
 * theirs.
 */
let runtime: DbHandle;
let world: PortalWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createPortalWorld(runtime, { slug: 'portal-isolation' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const audits = (action: string) =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, action as never)))
      .orderBy(asc(auditEvent.occurredAt)),
  );

let weeks = 0;
/** A booking for a patient on a Monday of its own, months away: far outside any cut-off. */
async function bookFor(patientId: string, time = '10:00') {
  weeks += 1;
  return world.book(10 + weeks, time, { patientId });
}

let soon = 0;
/** A booking on the first Monday after the clock, a week away: inside a long cut-off. */
async function bookSoon(patientId: string) {
  const slot = 9 * 60 + 30 * soon;
  soon += 1;
  const time = `${String(Math.floor(slot / 60)).padStart(2, '0')}:${slot % 60 === 0 ? '00' : '30'}`;
  return world.book(0, time, { patientId });
}

describe('whose record is shown', () => {
  it('picks the only record by itself and says who is signed in', async () => {
    const { visitor, identity, patientId, email } = await world.patientSession();

    const response = await visitor.get('/portal/me');

    expect(response.statusCode, response.body).toBe(200);
    const me = response.json<PortalMeResponse>();
    expect(me.email).toBe(email);
    expect(me.organizationName).toBeTruthy();
    expect(me.links).toHaveLength(1);
    expect(me.links[0]).toMatchObject({ patientId, relationship: 'self', status: 'active' });
    expect(me.selectedLinkId).toBe(identity.links[0]?.id);
    // No consent or prescription module is wired in this world: those sections are empty states.
    expect(me.capabilities).toEqual({ consents: false, prescriptions: false });
  });

  it('asks a parent to pick a child, lists both, and switches inside the same account', async () => {
    const parentEmail = `padres-${crypto.randomUUID().slice(0, 6)}@example.test`;
    const child1 = await world.patientWith({
      birthDate: '2020-09-14',
      email: null,
      givenNames: 'Ana',
    });
    const child2 = await world.patientWith({
      birthDate: '2022-01-02',
      email: null,
      givenNames: 'Beto',
    });
    const note = 'Presentó su DNI y la partida de nacimiento.';
    const invited = await world.inviteOk(child1, {
      email: parentEmail,
      relation: 'mother',
      verificationNote: note,
    });
    await world.activate(world.activationPathSentTo(parentEmail));
    await world.api.post(`/portal-identities/${invited.id}/links`, world.reception, {
      patientId: child2,
      relation: 'mother',
      verificationNote: note,
    });
    await bookFor(child1, '09:00');
    await bookFor(child2, '09:30');
    const visitor = await world.signInAs(parentEmail);

    const me = (await visitor.get('/portal/me')).json<PortalMeResponse>();
    expect(me.links.map((link) => link.patientName.split(' ')[0])).toEqual(['Ana', 'Beto']);
    expect(me.selectedLinkId).toBeNull();
    // Nothing is shown until the parent picks.
    const before = await visitor.get('/portal/appointments');
    expect(before.statusCode).toBe(409);
    expect(before.json<Problem>().code).toBe('portal_subject_required');

    const first = me.links[0];
    const second = me.links[1];
    const picked = await visitor.post('/portal/subject', { linkId: first?.id });
    expect(picked.statusCode, picked.body).toBe(200);
    expect(picked.json<PortalMeResponse>().selectedLinkId).toBe(first?.id);
    const ofFirst = (await visitor.get('/portal/appointments')).json<PortalAppointmentsResponse>();
    await visitor.post('/portal/subject', { linkId: second?.id });
    const ofSecond = (await visitor.get('/portal/appointments')).json<PortalAppointmentsResponse>();

    expect(ofFirst.upcoming).toHaveLength(1);
    expect(ofSecond.upcoming).toHaveLength(1);
    expect(ofFirst.upcoming[0]?.id).not.toBe(ofSecond.upcoming[0]?.id);
  });

  it('rejects the link of another account, a revoked one and one that does not exist, and records it', async () => {
    const mine = await world.patientSession();
    const theirs = await world.patientSession();
    const theirLink = theirs.identity.links[0]?.id ?? '';
    const before = (await audits('portal.denied')).length;

    const foreign = await mine.visitor.post('/portal/subject', { linkId: theirLink });
    const unknown = await mine.visitor.post('/portal/subject', {
      linkId: '0190a000-0000-7000-8000-00000000dead',
    });

    expect(foreign.statusCode).toBe(404);
    expect(foreign.json<Problem>().code).toBe('not_found');
    expect(unknown.statusCode).toBe(404);
    expect(foreign.body.replace(/"requestId":"[^"]+"/, '')).toBe(
      unknown.body.replace(/"requestId":"[^"]+"/, ''),
    );
    const rows = await audits('portal.denied');
    expect(rows.length).toBe(before + 2);
    expect(rows.at(-2)).toMatchObject({
      outcome: 'deny',
      actingRole: 'patient',
      actorUserId: null,
      resourceType: 'portal_link',
      resourceId: theirLink,
    });
    // Mine is still the subject.
    const me = (await mine.visitor.get('/portal/me')).json<PortalMeResponse>();
    expect(me.selectedLinkId).toBe(mine.identity.links[0]?.id);
  });

  it('loses a subject whose link was revoked, and asks to pick again', async () => {
    const { visitor, identity } = await world.patientSession();
    // Revoking a link ends the sessions; the person signs in again and finds the link gone.
    const revoked = await world.api.post(
      `/portal-links/${identity.links[0]?.id ?? ''}/revoke`,
      world.reception,
      {},
    );
    expect(revoked.statusCode).toBe(200);

    expect((await visitor.get('/portal/me')).statusCode).toBe(401);
  });

  it('never takes the patient or the organization from the request', async () => {
    const mine = await world.patientSession();
    const theirs = await world.patientSession();
    const theirAppointment = await bookFor(theirs.patientId);

    const withQuery = await mine.visitor.get(`/portal/appointments?patientId=${theirs.patientId}`);
    const body = await mine.visitor.get('/portal/appointments');

    expect(withQuery.statusCode).toBe(400);
    expect(withQuery.body).not.toContain(theirAppointment.id);
    expect(body.json<PortalAppointmentsResponse>().upcoming).toEqual([]);
  });
});

describe('appointments', () => {
  it('lists the upcoming ones with the professional, the place and the type, and only the own ones', async () => {
    const mine = await world.patientSession();
    const theirs = await world.patientSession();
    const booked = await bookFor(mine.patientId, '10:30');
    await bookFor(theirs.patientId, '11:00');

    const listed = (
      await mine.visitor.get('/portal/appointments')
    ).json<PortalAppointmentsResponse>();

    expect(listed.upcoming).toHaveLength(1);
    expect(listed.past).toEqual([]);
    expect(listed.upcoming[0]).toMatchObject({
      id: booked.id,
      status: 'scheduled',
      typeName: 'Consulta',
      locationName: 'Centro',
      mode: 'in_person',
      canConfirm: true,
      // Months away: outside the cut-off of 12 hours that is the default.
      canCancel: true,
      joinUrl: null,
      joinPending: false,
    });
    expect(listed.upcoming[0]?.professionalName).toBeTruthy();
    expect(listed.upcoming[0]?.cancelDeadline).toBeTruthy();
  });

  it('confirms an upcoming appointment', async () => {
    const { visitor, patientId } = await world.patientSession();
    const booked = await bookFor(patientId);

    const response = await visitor.post(`/portal/appointments/${booked.id}/confirm`, {});

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PortalAppointmentResponse>().appointment).toMatchObject({
      id: booked.id,
      status: 'confirmed',
      canConfirm: false,
    });
    const again = await visitor.post(`/portal/appointments/${booked.id}/confirm`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json<Problem>().code).toBe('portal_appointment_unavailable');
  });

  it('refuses to cancel inside the cut-off of the organization and leaves the appointment as it was', async () => {
    // A cut-off of 14 days: the appointment of next week is inside it. (The clock is not moved: the
    // staff sessions run on it.)
    await world.api.patch('/settings', world.owner, {
      onlineBooking: { rescheduleDeadlineHours: 336 },
    });
    try {
      const { visitor, patientId } = await world.patientSession();
      const booked = await bookSoon(patientId);

      const response = await visitor.post(`/portal/appointments/${booked.id}/cancel`, {});

      expect(response.statusCode).toBe(409);
      expect(response.json<Problem>().code).toBe('portal_cancel_deadline_passed');
      const [row] = await rowsOf<{ status: string }>(
        world,
        sql`SELECT status FROM appointment WHERE id = ${booked.id}`,
      );
      expect(row?.status).toBe('scheduled');
      const listed = (await visitor.get('/portal/appointments')).json<PortalAppointmentsResponse>();
      expect(listed.upcoming[0]).toMatchObject({
        id: booked.id,
        canCancel: false,
        canConfirm: true,
      });
    } finally {
      await world.api.patch('/settings', world.owner, {
        onlineBooking: { rescheduleDeadlineHours: 12 },
      });
    }
  });

  it('cancels outside the cut-off, frees the slot and says the patient did it', async () => {
    {
      const { visitor, patientId } = await world.patientSession();
      const booked = await bookFor(patientId, '11:30');

      const response = await visitor.post(`/portal/appointments/${booked.id}/cancel`, {});

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<PortalAppointmentResponse>().appointment).toMatchObject({
        status: 'cancelled',
        canCancel: false,
        canConfirm: false,
      });
      const [row] = await rowsOf<{ cancelled_by_kind: string; cancel_reason: string }>(
        world,
        sql`SELECT cancelled_by_kind, cancel_reason FROM appointment WHERE id = ${booked.id}`,
      );
      expect(row).toMatchObject({ cancelled_by_kind: 'patient', cancel_reason: 'patient_request' });
      const [occupied] = await rowsOf<{ n: number }>(
        world,
        sql`SELECT count(*)::int AS n FROM slot_occupancy WHERE appointment_id = ${booked.id} AND active`,
      );
      expect(occupied?.n).toBe(0);
      expect((await audits('appointment.cancelled')).some((a) => a.resourceId === booked.id)).toBe(
        true,
      );
    }
  });

  it("answers 404 and records it when the appointment is another patient's", async () => {
    const mine = await world.patientSession();
    const theirs = await world.patientSession();
    const theirAppointment = await bookFor(theirs.patientId);
    const before = (await audits('portal.denied')).length;

    const cancel = await mine.visitor.post(
      `/portal/appointments/${theirAppointment.id}/cancel`,
      {},
    );
    const confirm = await mine.visitor.post(
      `/portal/appointments/${theirAppointment.id}/confirm`,
      {},
    );

    expect(cancel.statusCode).toBe(404);
    expect(confirm.statusCode).toBe(404);
    expect(cancel.json<Problem>().code).toBe('not_found');
    const rows = (await audits('portal.denied')).slice(before);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      resourceType: 'appointment',
      resourceId: theirAppointment.id,
      patientId: mine.patientId,
      actingRole: 'patient',
    });
    // The other patient's appointment did not change.
    const [row] = await rowsOf<{ status: string }>(
      world,
      sql`SELECT status FROM appointment WHERE id = ${theirAppointment.id}`,
    );
    expect(row?.status).toBe('scheduled');
  });

  it("answers 404 for an appointment that never existed, the same as for another patient's", async () => {
    const { visitor } = await world.patientSession();

    const response = await visitor.post(
      '/portal/appointments/0190a000-0000-7000-8000-00000000dead/cancel',
      {},
    );

    expect(response.statusCode).toBe(404);
  });
});

describe('the past', () => {
  it('lists what already happened, newest first, apart from what is to come', async () => {
    const clocked = await createPortalWorld(runtime, { slug: 'portal-isolation-past' });
    try {
      const { patientId, email } = await clocked.patientSession();
      const first = await clocked.book(1, '09:00', { patientId });
      const second = await clocked.book(2, '09:00', { patientId });
      const later = await clocked.book(6, '09:00', { patientId });
      // Three weeks later: the first two are behind, the last is still to come. (The staff
      // sessions end on this clock; the patient signs in again after it moved.)
      clocked.advance(24 * 24 * 3_600_000);
      const visitor = await clocked.signInAs(email);

      const listed = (await visitor.get('/portal/appointments')).json<PortalAppointmentsResponse>();

      expect(listed.past.map((appointment) => appointment.id)).toEqual([second.id, first.id]);
      expect(listed.upcoming.map((appointment) => appointment.id)).toEqual([later.id]);
      expect(
        listed.past.every((appointment) => !appointment.canCancel && !appointment.canConfirm),
      ).toBe(true);
    } finally {
      await clocked.close();
    }
  });
});
