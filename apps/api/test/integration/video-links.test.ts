import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { VideoProviderUnavailableError } from '../../src/modules/teleconsultation/application/ports.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createActionTokens } from '../../src/platform/tokens/index.js';
import { asTenant } from '../support/tenants.js';
import { createVideoWorld, type VideoWorld } from '../support/video-world.js';

let runtime: DbHandle;
let world: VideoWorld;

const OPAQUE = /^[0-9a-f]{32}$/;

/** Every booking takes a Monday of its own, so the tests never collide. */
let week = 0;
const nextWeek = () => ++week;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createVideoWorld(runtime, { slug: 'video-links' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

beforeEach(async () => {
  world.setNow(new Date('2031-05-05T12:00:00.000Z'));
  world.setVideoNow(new Date('2031-05-05T12:00:00.000Z'));
  world.forgetPastWork();
  world.useProvider(world.provider);
  world.provider.failWith(null);
  await setIntegration(true);
});

async function setIntegration(video: boolean) {
  const response = await world.api.patch('/settings', world.owner, { integrations: { video } });
  expect(response.statusCode, response.body).toBe(200);
}

/** A join token for an appointment, as the reminder would issue it. */
async function issueJoinToken(appointmentId: string, room: string | null) {
  return asTenant(runtime, world.tenant.id, (tx) =>
    createActionTokens({ clock: () => world.now() }).issue(tx, {
      kind: 'video_join',
      subjectId: appointmentId,
      payload: { room },
      ttlMs: 60 * 60 * 1000,
    }),
  );
}

async function tokenWorks(appointmentId: string, token: string) {
  return asTenant(runtime, world.tenant.id, async (tx) => {
    const inspected = await createActionTokens({ clock: () => world.now() }).inspect(
      tx,
      'video_join',
      token,
    );
    return inspected?.subjectId === appointmentId;
  });
}

describe('a virtual appointment gets a video session', () => {
  it('opens a session without a link and queues the room, naming it with 128 random bits', async () => {
    const created = await world.bookVirtual(nextWeek(), '10:00');

    const session = await world.sessionOf(created.id);
    const room = await world.roomOf(created.id);
    expect(session).toMatchObject({ status: 'link_pending', pendingReason: 'creating' });
    expect(room).toMatch(OPAQUE);
    expect(world.jobs.pending('video.link.create')).toHaveLength(1);
    expect(world.jobs.pending('video.link.create')[0]?.payload).toMatchObject({
      tenantId: world.tenant.id,
      appointmentId: created.id,
      room,
    });
    expect(world.provider.asked).not.toContain(room);
  });

  it('creates the room with the provider and marks the session ready, sending nothing but the opaque name', async () => {
    const created = await world.bookVirtual(nextWeek(), '10:00');
    const room = await world.roomOf(created.id);

    const results = await world.runVideoJobs();

    expect(results).toEqual([{ name: 'video.link.create', result: { status: 'completed' } }]);
    expect(world.provider.asked).toEqual([room]);
    expect(await world.sessionOf(created.id)).toMatchObject({
      status: 'ready',
      pendingReason: null,
      provider: 'local',
    });
    // Nothing about the patient reaches the provider: the only thing it received is the name.
    expect(room).not.toContain(created.patientId.replaceAll('-', ''));
  });

  it('audits the creation of the link without the room, the address or a token', async () => {
    const created = await world.bookVirtual(nextWeek(), '10:00');
    const room = await world.roomOf(created.id);
    await world.runVideoJobs();

    const [entry] = await world.auditsOf('video.link.created', created.id);

    expect(entry).toMatchObject({
      action: 'video.link.created',
      outcome: 'allow',
      resourceType: 'appointment',
      metadata: { provider: 'local' },
    });
    expect(JSON.stringify(entry)).not.toContain(room ?? 'missing');
  });

  it('does nothing for an in person appointment: no session, no room, no job', async () => {
    const created = await world.book(nextWeek(), '11:00');

    expect(await world.sessionOf(created.id)).toBeNull();
    expect(await world.roomOf(created.id)).toBeNull();
    expect(world.jobs.pending('video.link.create')).toHaveLength(0);
  });

  it('opens one session for each session of a virtual series', async () => {
    const first = nextWeek();
    week += 2;
    const body = await world.bookingBody(first, '10:00', { appointmentTypeId: world.virtual });

    const response = await world.api.post('/appointments/series', world.reception, {
      ...body,
      recurrence: { frequency: 'weekly', count: 3 },
      mode: 'commit',
    });

    expect(response.statusCode, response.body).toBe(201);
    const ids = response.json<{ appointments: { id: string }[] }>().appointments.map((a) => a.id);
    expect(ids).toHaveLength(3);
    const rooms = await Promise.all(ids.map((id) => world.roomOf(id)));
    expect(new Set(rooms).size).toBe(3);
    for (const id of ids) expect((await world.sessionOf(id))?.status).toBe('link_pending');
  });
});

describe('the video session follows the appointment', () => {
  it('gives a rescheduled appointment a new room and kills the old address', async () => {
    const thisWeek = nextWeek();
    const created = await world.bookVirtual(thisWeek, '10:00');
    const first = await world.roomOf(created.id);
    await world.runVideoJobs();
    const old = await issueJoinToken(created.id, first);
    expect(await tokenWorks(created.id, old.token)).toBe(true);

    const moved = await world.act(created, 'reschedule', world.reception, {
      local: { date: world.monday(thisWeek), time: '11:00' },
    });

    expect(moved.statusCode, moved.body).toBe(200);
    const second = await world.roomOf(created.id);
    expect(second).toMatch(OPAQUE);
    expect(second).not.toBe(first);
    expect(await world.sessionOf(created.id)).toMatchObject({
      status: 'link_pending',
      pendingReason: 'creating',
      provider: null,
      firstOpenedAt: null,
    });
    expect(await tokenWorks(created.id, old.token)).toBe(false);
    expect(await world.auditsOf('video.link.revoked', created.id)).toHaveLength(1);

    await world.runVideoJobs();
    expect(world.provider.asked).toEqual([first, second]);
    expect((await world.sessionOf(created.id))?.status).toBe('ready');
  });

  it('ignores a room-creation job for a room that was replaced meanwhile', async () => {
    const thisWeek = nextWeek();
    const created = await world.bookVirtual(thisWeek, '12:00');
    const first = await world.roomOf(created.id);
    const asked = world.provider.asked.length;

    const moved = await world.act(created, 'reschedule', world.reception, {
      local: { date: world.monday(thisWeek), time: '09:00' },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const second = await world.roomOf(created.id);

    // Both jobs are waiting: the old one is stale and must not ask the provider for the old room.
    await world.runVideoJobs();

    expect(world.provider.asked.slice(asked)).toEqual([second]);
    expect(world.provider.asked).not.toContain(first);
  });

  it('gives a reassigned appointment a new room, so the previous professional loses the link', async () => {
    const created = await world.bookVirtual(nextWeek(), '10:00');
    const first = await world.roomOf(created.id);
    await world.runVideoJobs();
    const old = await issueJoinToken(created.id, first);

    const moved = await world.act(created, 'reschedule', world.reception, {
      professionalId: world.colleague.professionalId,
    });

    expect(moved.statusCode, moved.body).toBe(200);
    expect(await world.roomOf(created.id)).not.toBe(first);
    expect(await tokenWorks(created.id, old.token)).toBe(false);
    expect((await world.sessionOf(created.id))?.status).toBe('link_pending');
  });

  it('closes the session and revokes the address when the appointment is cancelled', async () => {
    const created = await world.bookVirtual(nextWeek(), '10:00');
    await world.runVideoJobs();
    const room = await world.roomOf(created.id);
    const token = await issueJoinToken(created.id, room);

    const cancelled = await world.act(created, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'patient_request',
    });

    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(await world.sessionOf(created.id)).toMatchObject({
      status: 'closed',
      closeReason: 'cancelled',
      pendingReason: null,
    });
    expect(await world.roomOf(created.id)).toBeNull();
    expect(await tokenWorks(created.id, token.token)).toBe(false);
    expect(await world.auditsOf('video.link.revoked', created.id)).toHaveLength(1);
  });

  it('closes the session for good when the patient did not come', async () => {
    const created = await world.bookVirtual(nextWeek(), '10:00');
    await world.runVideoJobs();
    // 2031-05-12 + 6 weeks, 10:00 in Buenos Aires: the video clock must be past the 15 minute wait.
    const startsAt = new Date(created.startsAt);
    world.setNow(new Date(startsAt.getTime() + 20 * 60_000));
    world.setVideoNow(new Date(startsAt.getTime() + 20 * 60_000));

    const response = await world.act(created, 'no-show', world.reception);

    expect(response.statusCode, response.body).toBe(200);
    expect(await world.sessionOf(created.id)).toMatchObject({
      status: 'closed',
      closeReason: 'no_show',
    });
  });

  it('refuses a no-show before the configured minutes have passed, and changes nothing', async () => {
    const created = await world.bookVirtual(nextWeek(), '10:00');
    await world.runVideoJobs();
    const startsAt = new Date(created.startsAt);
    // Scheduling accepts a no-show from the start; the video wait is 15 minutes more.
    world.setNow(new Date(startsAt.getTime() + 5 * 60_000));
    world.setVideoNow(new Date(startsAt.getTime() + 5 * 60_000));

    const early = await world.act(created, 'no-show', world.reception);

    expect(early.statusCode, early.body).toBe(409);
    expect(early.json<{ code: string }>().code).toBe('video_no_show_too_early');
    expect((await world.sessionOf(created.id))?.status).toBe('ready');
    expect(await world.versionOf(created.id)).toBe(created.version);

    world.setNow(new Date(startsAt.getTime() + 16 * 60_000));
    world.setVideoNow(new Date(startsAt.getTime() + 16 * 60_000));
    const late = await world.act(created, 'no-show', world.reception);
    expect(late.statusCode, late.body).toBe(200);
  });

  it('does not wait to mark a no-show on an appointment that is not virtual', async () => {
    const created = await world.book(nextWeek(), '10:00');
    const startsAt = new Date(created.startsAt);
    world.setNow(new Date(startsAt.getTime() + 2 * 60_000));
    world.setVideoNow(new Date(startsAt.getTime() + 2 * 60_000));

    const response = await world.act(created, 'no-show', world.reception);

    expect(response.statusCode, response.body).toBe(200);
  });
});

describe('when there is no provider, or it fails', () => {
  it('makes no provider call and says so when the organization switched the integration off', async () => {
    await setIntegration(false);
    const asked = world.provider.asked.length;

    const created = await world.bookVirtual(nextWeek(), '10:00');

    expect(await world.sessionOf(created.id)).toMatchObject({
      status: 'link_pending',
      pendingReason: 'integration_off',
    });
    expect(await world.roomOf(created.id)).toBeNull();
    expect(world.jobs.pending('video.link.create')).toHaveLength(0);
    expect(world.provider.asked.length).toBe(asked);
  });

  it('leaves the session pending when the deployment has no provider for the organization', async () => {
    world.useProvider(undefined);

    const created = await world.bookVirtual(nextWeek(), '11:00');

    expect(await world.sessionOf(created.id)).toMatchObject({
      status: 'link_pending',
      pendingReason: 'provider_unavailable',
    });
    expect(world.jobs.pending('video.link.create')).toHaveLength(0);
  });

  it('marks the session unavailable at once when the provider says it cannot be reached at all', async () => {
    const created = await world.bookVirtual(nextWeek(), '10:00');
    world.provider.failWith(new VideoProviderUnavailableError());

    const results = await world.runVideoJobs();

    expect(results).toEqual([{ name: 'video.link.create', result: { status: 'completed' } }]);
    expect(await world.sessionOf(created.id)).toMatchObject({
      status: 'link_pending',
      pendingReason: 'provider_unavailable',
    });
  });

  it('retries a transient failure, and after the last retry leaves a pending session with an alert', async () => {
    const created = await world.bookVirtual(nextWeek(), '11:00');
    const payload = world.jobPayloadFor(created.id);
    world.provider.failWith(new Error('provider timeout'));

    await expect(world.runVideoJob(payload, 0)).rejects.toThrow();
    await expect(world.runVideoJob(payload, 2)).rejects.toThrow();
    // A failed attempt rolls back: the session still says it is being created.
    expect(await world.sessionOf(created.id)).toMatchObject({ pendingReason: 'creating' });

    const last = await world.runVideoJob(payload, 3);

    expect(last).toEqual({ status: 'completed' });
    expect(await world.sessionOf(created.id)).toMatchObject({
      status: 'link_pending',
      pendingReason: 'provider_failed',
    });
  });

  it('succeeds on a retry once the provider works again', async () => {
    const created = await world.bookVirtual(nextWeek(), '10:00');
    const payload = world.jobPayloadFor(created.id);
    world.provider.failWith(new Error('provider timeout'));
    await expect(world.runVideoJob(payload, 0)).rejects.toThrow();
    world.provider.failWith(null);

    const retry = await world.runVideoJob(payload, 1);

    expect(retry).toEqual({ status: 'completed' });
    expect((await world.sessionOf(created.id))?.status).toBe('ready');
  });
});
