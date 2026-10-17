import type { AppointmentDto, VideoSessionSummary } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { tenant } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { clientFor, signInAs, TEST_PASSWORD } from '../support/session.js';
import { asTenant, createTestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';
import { createVideoWorld, type VideoWorld } from '../support/video-world.js';

let runtime: DbHandle;
let world: VideoWorld;

const MINUTE = 60_000;
let week = 200;
const nextWeek = () => ++week;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createVideoWorld(runtime, { slug: 'video-pro' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

beforeEach(async () => {
  world.forgetPastWork();
  world.useProvider(world.provider);
  world.provider.failWith(null);
  const response = await world.api.patch('/settings', world.owner, {
    integrations: { video: true },
  });
  expect(response.statusCode, response.body).toBe(200);
});

/** A ready virtual appointment (10:00 local), with the video clock `minutes` from its start. */
async function ready(minutesFromStart: number): Promise<AppointmentDto> {
  const appointment = await world.bookVirtual(nextWeek(), '10:00');
  await world.runVideoJobs();
  world.setVideoNow(new Date(new Date(appointment.startsAt).getTime() + minutesFromStart * MINUTE));
  return appointment;
}

const summaryOf = async (appointment: AppointmentDto, as = world.reception) => {
  const response = await world.api.get(`/appointments/${appointment.id}/video`, as);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<VideoSessionSummary>();
};

describe('the assigned professional joins', () => {
  it('gets the address of the call inside the window, and the join is audited without it', async () => {
    const appointment = await ready(-10);
    const room = (await world.roomOf(appointment.id)) ?? '';

    const response = await world.api.post(
      `/appointments/${appointment.id}/video/join`,
      world.doctor,
      {},
    );

    expect(response.statusCode, response.body).toBe(200);
    const { url } = response.json<{ url: string }>();
    expect(new URL(url).origin).toBe('https://meet.jit.si');
    expect(new URL(url).pathname).toBe(`/${room}`);
    const [entry] = await world.auditsOf('video.link.joined', appointment.id);
    expect(entry).toMatchObject({
      action: 'video.link.joined',
      outcome: 'allow',
      actorUserId: world.doctor.user.id,
      metadata: { manual: false },
    });
    expect(JSON.stringify(entry)).not.toContain(room);
    expect(JSON.stringify(entry)).not.toContain('jit.si');
  });

  it('refuses to join before the window opens and after it closes, saying so', async () => {
    const early = await ready(-30);
    const late = await ready(95);

    for (const appointment of [early, late]) {
      const response = await world.api.post(
        `/appointments/${appointment.id}/video/join`,
        world.doctor,
        {},
      );
      expect(response.statusCode).toBe(409);
      expect(response.json<{ code: string }>().code).toBe('video_outside_window');
      expect(await world.auditsOf('video.link.joined', appointment.id)).toHaveLength(0);
    }
  });

  it('denies a colleague who is not the assigned professional, and records the denial', async () => {
    const appointment = await ready(0);

    const response = await world.api.post(
      `/appointments/${appointment.id}/video/join`,
      world.colleague,
      {},
    );

    expect(response.statusCode).toBe(403);
    expect(await world.auditsOf('video.link.joined', appointment.id)).toHaveLength(0);
    expect(await world.auditsOf('access.denied', appointment.id)).toHaveLength(1);
  });

  it('is not an action of reception, an administrator or the owner, who are not participants', async () => {
    const appointment = await ready(0);

    for (const who of [world.reception, world.admin, world.owner]) {
      const response = await world.api.post(`/appointments/${appointment.id}/video/join`, who, {});
      expect(response.statusCode).toBe(403);
    }
  });

  it('says the link is not available while the room is pending, and that an in person visit has none', async () => {
    const pending = await world.bookVirtual(nextWeek(), '11:00');
    world.setVideoNow(new Date(new Date(pending.startsAt).getTime()));
    const inPerson = await world.book(nextWeek(), '11:00');

    const noLink = await world.api.post(`/appointments/${pending.id}/video/join`, world.doctor, {});
    const notVirtual = await world.api.post(
      `/appointments/${inPerson.id}/video/join`,
      world.doctor,
      {},
    );

    expect(noLink.statusCode).toBe(409);
    expect(noLink.json<{ code: string }>().code).toBe('video_link_unavailable');
    expect(notVirtual.statusCode).toBe(409);
    expect(notVirtual.json<{ code: string }>().code).toBe('video_not_virtual');
  });

  it('answers as not found for an appointment of another organization', async () => {
    const appointment = await ready(0);
    const other = await createTestTenant(runtime, { slug: 'video-pro-other' });
    const stranger = await createTestUser(runtime, other.id, {
      roles: ['professional'],
      password: TEST_PASSWORD,
    });
    const session = await signInAs(world.app, other.slug, stranger);
    const otherApi = clientFor(world.app, other.slug);

    const summary = await otherApi.get(`/appointments/${appointment.id}/video`, session);
    const join = await otherApi.post(`/appointments/${appointment.id}/video/join`, session, {});
    const manual = await otherApi.put(
      `/appointments/${appointment.id}/video/manual-link`,
      session,
      {
        url: 'https://meet.google.com/abc',
      },
    );

    expect(summary.statusCode).toBe(404);
    expect(join.statusCode).toBe(404);
    expect(manual.statusCode).toBe(404);
  });
});

describe('a read-only organization', () => {
  it('still shows the video side but refuses to join or to attach a link', async () => {
    const appointment = await ready(0);
    const setStatus = (status: 'active' | 'read_only') =>
      asTenant(runtime, world.tenant.id, (tx) =>
        tx
          .update(tenant)
          .set({ status, readOnlySince: status === 'read_only' ? new Date() : null })
          .where(eq(tenant.id, world.tenant.id)),
      );
    await setStatus('read_only');
    try {
      const summary = await world.api.get(`/appointments/${appointment.id}/video`, world.doctor);
      const join = await world.api.post(
        `/appointments/${appointment.id}/video/join`,
        world.doctor,
        {},
      );
      const manual = await world.api.put(
        `/appointments/${appointment.id}/video/manual-link`,
        world.reception,
        { url: 'https://zoom.us/j/1' },
      );

      expect(summary.statusCode).toBe(200);
      expect(join.statusCode).toBe(402);
      expect(manual.statusCode).toBe(402);
      expect(await world.auditsOf('video.link.joined', appointment.id)).toHaveLength(0);
    } finally {
      await setStatus('active');
    }
  });
});

describe('what each role sees of the video side', () => {
  it('shows reception that the appointment is virtual and has a link, and never an address', async () => {
    const appointment = await ready(-10);

    const summary = await summaryOf(appointment, world.reception);

    expect(summary).toMatchObject({
      virtual: true,
      status: 'ready',
      hasLink: true,
      manual: false,
      patientOpenedLink: false,
      integrationEnabled: true,
      canJoin: false,
      canAttachManualLink: true,
    });
    expect(JSON.stringify(summary)).not.toMatch(/https?:|jit\.si/);
    expect(summary.window).toEqual({
      opensAt: new Date(new Date(appointment.startsAt).getTime() - 15 * MINUTE).toISOString(),
      closesAt: new Date(new Date(appointment.endsAt).getTime() + 60 * MINUTE).toISOString(),
    });
    expect(summary.noShowAllowedFrom).toBe(
      new Date(new Date(appointment.startsAt).getTime() + 15 * MINUTE).toISOString(),
    );
  });

  it('offers the join action to the assigned professional only, and only inside the window', async () => {
    const appointment = await ready(-5);
    expect((await summaryOf(appointment, world.doctor)).canJoin).toBe(true);
    expect((await summaryOf(appointment, world.reception)).canJoin).toBe(false);

    const early = await ready(-60);
    expect((await summaryOf(early, world.doctor)).canJoin).toBe(false);
  });

  it('reports an appointment in person as not virtual', async () => {
    const appointment = await world.book(nextWeek(), '12:00');

    expect(await summaryOf(appointment)).toMatchObject({
      virtual: false,
      status: null,
      hasLink: false,
      window: null,
      canJoin: false,
      canAttachManualLink: false,
      noShowAllowedFrom: null,
    });
  });

  it('keeps the link out of the calendar feed that every role reads', async () => {
    const appointment = await ready(0);
    const room = (await world.roomOf(appointment.id)) ?? '';
    const day = new Date(appointment.startsAt);
    const from = new Date(day.getTime() - 60 * MINUTE).toISOString();
    const to = new Date(day.getTime() + 8 * 60 * MINUTE).toISOString();

    for (const who of [world.reception, world.doctor, world.owner]) {
      const feed = await world.api.get(
        `/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        who,
      );
      expect(feed.statusCode, feed.body).toBe(200);
      expect(feed.body).toContain(appointment.id);
      expect(feed.body).not.toContain(room);
      expect(feed.body).not.toMatch(/jit\.si|video_?room|videoLink/i);
    }
  });

  it("hides an appointment of another professional's calendar from a colleague", async () => {
    const appointment = await ready(0);

    const response = await world.api.get(`/appointments/${appointment.id}/video`, world.colleague);

    expect(response.statusCode).toBe(403);
  });
});

describe('the manual link fallback', () => {
  it('lets the assigned professional attach a link from an allowed host, which the join then uses', async () => {
    const appointment = await world.bookVirtual(nextWeek(), '09:30');
    world.setVideoNow(new Date(new Date(appointment.startsAt).getTime()));

    const attached = await world.api.put(
      `/appointments/${appointment.id}/video/manual-link`,
      world.doctor,
      { url: 'https://meet.google.com/abc-defg-hij?authuser=0' },
    );

    expect(attached.statusCode, attached.body).toBe(200);
    expect(attached.json<VideoSessionSummary>()).toMatchObject({
      status: 'ready',
      hasLink: true,
      manual: true,
    });
    expect(attached.body).not.toContain('meet.google.com');
    const join = await world.api.post(
      `/appointments/${appointment.id}/video/join`,
      world.doctor,
      {},
    );
    expect(join.json<{ url: string }>().url).toBe(
      'https://meet.google.com/abc-defg-hij?authuser=0',
    );
    const [entry] = await world.auditsOf('video.link.manual_attached', appointment.id);
    expect(entry).toMatchObject({
      action: 'video.link.manual_attached',
      metadata: { host: 'meet.google.com' },
    });
    expect(JSON.stringify(entry)).not.toContain('abc-defg-hij');
    expect((await world.auditsOf('video.link.joined', appointment.id))[0]?.metadata).toEqual({
      manual: true,
    });
  });

  it('lets reception attach a link to an appointment that is waiting for one', async () => {
    await world.api.patch('/settings', world.owner, { integrations: { video: false } });
    const appointment = await world.bookVirtual(nextWeek(), '09:30');
    expect(await summaryOf(appointment)).toMatchObject({
      status: 'link_pending',
      pendingReason: 'integration_off',
      hasLink: false,
      integrationEnabled: false,
    });

    const attached = await world.api.put(
      `/appointments/${appointment.id}/video/manual-link`,
      world.reception,
      { url: 'https://us02web.zoom.us/j/123456789' },
    );

    expect(attached.statusCode, attached.body).toBe(200);
    expect(attached.json<VideoSessionSummary>()).toMatchObject({
      status: 'ready',
      pendingReason: null,
      hasLink: true,
      manual: true,
    });
  });

  it.each([
    ['a plain http address', 'http://meet.google.com/abc', 'not_https'],
    ['a host that is not allowed', 'https://evil.example/abc', 'host_not_allowed'],
    ['something that is not an address', 'meet.google.com/abc', 'not_a_link'],
    ['credentials in the address', 'https://u:p@meet.google.com/abc', 'credentials'],
  ])('rejects %s, naming the field', async (_label, url, reason) => {
    const appointment = await ready(0);

    const response = await world.api.put(
      `/appointments/${appointment.id}/video/manual-link`,
      world.doctor,
      { url },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: { path: string; i18nKey: string }[] }>().errors).toEqual([
      { path: 'url', i18nKey: `teleconsultation.manual_link.${reason}` },
    ]);
    expect(await world.auditsOf('video.link.manual_attached', appointment.id)).toHaveLength(0);
  });

  it('does not attach a link to an appointment in person, to a closed session, or from another calendar', async () => {
    const inPerson = await world.book(nextWeek(), '12:00');
    const closed = await ready(0);
    await world.act(closed, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'patient_request',
    });
    const other = await ready(0);
    const link = { url: 'https://meet.google.com/abc' };

    const notVirtual = await world.api.put(
      `/appointments/${inPerson.id}/video/manual-link`,
      world.doctor,
      link,
    );
    const afterCancel = await world.api.put(
      `/appointments/${closed.id}/video/manual-link`,
      world.doctor,
      link,
    );
    const foreign = await world.api.put(
      `/appointments/${other.id}/video/manual-link`,
      world.colleague,
      link,
    );

    expect(notVirtual.json<{ code: string }>().code).toBe('video_not_virtual');
    expect(afterCancel.json<{ code: string }>().code).toBe('video_link_unavailable');
    expect(foreign.statusCode).toBe(403);
  });

  it('sets the manual link aside when the appointment moves, because it belonged to the old session', async () => {
    const thisWeek = nextWeek();
    const appointment = await world.bookVirtual(thisWeek, '11:30');
    await world.api.put(`/appointments/${appointment.id}/video/manual-link`, world.doctor, {
      url: 'https://meet.google.com/abc-defg-hij',
    });

    const moved = await world.act(appointment, 'reschedule', world.reception, {
      local: { date: world.monday(thisWeek), time: '12:00' },
    });

    expect(moved.statusCode, moved.body).toBe(200);
    expect((await world.sessionOf(appointment.id))?.manualLink).toBeNull();
  });
});
