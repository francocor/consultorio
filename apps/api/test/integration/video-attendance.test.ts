import type { AppointmentDto, VideoSessionSummary } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { appointment as appointmentTable } from '../../src/db/schema/scheduling.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createActionTokens } from '../../src/platform/tokens/index.js';
import { hostOf } from '../support/app.js';
import { asTenant } from '../support/tenants.js';
import { createVideoWorld, type VideoWorld } from '../support/video-world.js';

let runtime: DbHandle;
let world: VideoWorld;

const MINUTE = 60_000;
let week = 300;
const nextWeek = () => ++week;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createVideoWorld(runtime, { slug: 'video-attendance' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

beforeEach(() => {
  world.forgetPastWork();
  world.useProvider(world.provider);
});

/** A ready virtual appointment at 10:00 local; both clocks stand `minutes` from its start. */
async function ready(minutesFromStart: number): Promise<AppointmentDto> {
  const created = await world.bookVirtual(nextWeek(), '10:00');
  await world.runVideoJobs();
  moveClocks(created, minutesFromStart);
  return created;
}

function moveClocks(created: AppointmentDto, minutesFromStart: number) {
  const now = new Date(new Date(created.startsAt).getTime() + minutesFromStart * MINUTE);
  world.setNow(now);
  world.setVideoNow(now);
}

const summaryOf = async (created: AppointmentDto) => {
  const response = await world.api.get(`/appointments/${created.id}/video`, world.reception);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<VideoSessionSummary>();
};

const statusOf = async (id: string) => {
  const [row] = await asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .select({ status: appointmentTable.status, version: appointmentTable.version })
      .from(appointmentTable)
      .where(eq(appointmentTable.id, id)),
  );
  return row;
};

async function issueToken(created: AppointmentDto) {
  const room = (await world.roomOf(created.id)) ?? '';
  const issued = await asTenant(runtime, world.tenant.id, (tx) =>
    createActionTokens({ clock: () => world.videoNow() }).issue(tx, {
      kind: 'video_join',
      subjectId: created.id,
      payload: { room },
    }),
  );
  return issued.token;
}

const openLink = (token: string) =>
  world.app.inject({
    method: 'GET',
    url: `/public/v/${token}`,
    headers: { host: hostOf(world.slug), 'user-agent': 'vitest-patient' },
  });

describe('virtual appointment attendance', () => {
  it('lets the professional mark a no-show when the patient never joined', async () => {
    const created = await ready(20);

    expect((await summaryOf(created)).patientOpenedLink).toBe(false);
    const response = await world.act(created, 'no-show', world.reception);

    expect(response.statusCode, response.body).toBe(200);
    expect((await statusOf(created.id))?.status).toBe('no_show');
  });

  it('shows reception and the professional that the patient opened the link, without moving the status', async () => {
    const created = await ready(-5);
    const token = await issueToken(created);
    expect((await openLink(token)).statusCode).toBe(302);
    const before = await statusOf(created.id);

    const summary = await summaryOf(created);
    expect(summary.patientOpenedLink).toBe(true);
    expect(summary.firstOpenedAt).toBe(new Date(world.videoNow()).toISOString());
    const asDoctor = await world.api.get(`/appointments/${created.id}/video`, world.doctor);
    expect(asDoctor.json<VideoSessionSummary>().patientOpenedLink).toBe(true);

    // The appointment ends and the window closes: nobody and nothing changes the attendance.
    moveClocks(created, 24 * 60);
    await world.runVideoJobs();
    expect(await statusOf(created.id)).toEqual(before);
    expect(before?.status).toBe('scheduled');
  });

  it('keeps the no-show possible after the patient opened the link but never came to the call', async () => {
    const created = await ready(-5);
    expect((await openLink(await issueToken(created))).statusCode).toBe(302);
    moveClocks(created, 20);

    const response = await world.act(created, 'no-show', world.reception);

    expect(response.statusCode, response.body).toBe(200);
  });

  it('lets the professional start the session after joining it, and attending closes the link', async () => {
    const created = await ready(-3);
    const token = await issueToken(created);
    const checkedIn = await world.act(created, 'check-in', world.reception, {
      confirmIdentity: true,
    });
    expect(checkedIn.statusCode, checkedIn.body).toBe(200);

    const joined = await world.api.post(`/appointments/${created.id}/video/join`, world.doctor, {});
    expect(joined.statusCode, joined.body).toBe(200);
    const started = await world.act(created, 'start', world.doctor);
    expect(started.statusCode, started.body).toBe(200);
    expect((await statusOf(created.id))?.status).toBe('in_progress');
    expect((await world.sessionOf(created.id))?.status).toBe('ready');

    const attended = await world.act(created, 'attend', world.doctor);
    expect(attended.statusCode, attended.body).toBe(200);
    expect(await world.sessionOf(created.id)).toMatchObject({
      status: 'closed',
      closeReason: 'attended',
    });
    // The address the patient had stops working with the attendance.
    const after = await openLink(token);
    expect(after.statusCode).toBe(404);
    expect(after.headers['location']).toBeUndefined();
  });
});

describe('the audit trail of a link holds the events and never the secrets', () => {
  it('records created, opened, joined, manual attachment and revocation with actor and time only', async () => {
    const created = await ready(-5);
    const room = (await world.roomOf(created.id)) ?? '';
    const token = await issueToken(created);
    await openLink(token);
    const joined = await world.api.post(`/appointments/${created.id}/video/join`, world.doctor, {});
    expect(joined.statusCode, joined.body).toBe(200);
    const manual = await world.api.put(
      `/appointments/${created.id}/video/manual-link`,
      world.doctor,
      { url: 'https://zoom.us/j/987654321?pwd=SECRETPASSCODE' },
    );
    expect(manual.statusCode, manual.body).toBe(200);
    const cancelled = await world.act(created, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'patient_request',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const entries = await asTenant(runtime, world.tenant.id, (tx) =>
      tx.select().from(auditEvent).where(eq(auditEvent.resourceId, created.id)),
    );
    const video = entries.filter((entry) => entry.action.startsWith('video.link.'));

    expect(video.map((entry) => entry.action).sort()).toEqual([
      'video.link.created',
      'video.link.joined',
      'video.link.manual_attached',
      'video.link.opened',
      'video.link.revoked',
    ]);
    for (const entry of video) {
      expect(entry.occurredAt).toBeInstanceOf(Date);
      expect(entry.outcome).toBe('allow');
    }
    const everything = JSON.stringify(video);
    for (const secret of [token, room, 'SECRETPASSCODE', '987654321', 'jit.si', 'https://']) {
      expect(everything, secret).not.toContain(secret);
    }
    expect(video.find((entry) => entry.action === 'video.link.joined')?.actorUserId).toBe(
      world.doctor.user.id,
    );
    expect(video.find((entry) => entry.action === 'video.link.opened')?.actorUserId).toBeNull();
  });
});
