import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { videoSession } from '../../src/db/schema/teleconsultation.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createActionTokens } from '../../src/platform/tokens/index.js';
import { hostOf } from '../support/app.js';
import { asTenant } from '../support/tenants.js';
import { createVideoWorld, type VideoWorld } from '../support/video-world.js';

/**
 * Judgment day finding C9: a manual video link can carry a passcode, so it does not rest in
 * plaintext. It is encrypted with the key of the organization, and a link written before that (the
 * legacy column) is still followed and is replaced by its encrypted form the first time.
 */

const MINUTE = 60_000;
const LINK = 'https://zoom.us/j/987654321?pwd=SECRETPASSCODE';

let runtime: DbHandle;
let world: VideoWorld;
let week = 700;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createVideoWorld(runtime, { slug: 'video-link-enc' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

beforeEach(() => {
  world.forgetPastWork();
  world.useProvider(world.provider);
});

async function inWindow() {
  week += 1;
  const appointment = await world.bookVirtual(week, '10:00');
  await world.runVideoJobs();
  const startsAt = new Date(appointment.startsAt);
  world.setNow(new Date(startsAt.getTime() - 5 * MINUTE));
  world.setVideoNow(new Date(startsAt.getTime() - 5 * MINUTE));
  const room = (await world.roomOf(appointment.id)) ?? '';
  const issued = await asTenant(runtime, world.tenant.id, (tx) =>
    createActionTokens({ clock: () => world.videoNow() }).issue(tx, {
      kind: 'video_join',
      subjectId: appointment.id,
      payload: { room },
      ttlMs: 60 * MINUTE,
    }),
  );
  return { appointment, token: issued.token };
}

const raw = (appointmentId: string) =>
  asTenant(runtime, world.tenant.id, async (tx) => {
    const result = await tx.execute<{ manual_link: string | null; enc: Buffer | null }>(
      sql`SELECT manual_link, manual_link_enc AS enc FROM video_session WHERE appointment_id = ${appointmentId}`,
    );
    return result.rows[0];
  });

const enter = (token: string) =>
  world.app.inject({
    method: 'POST',
    url: `/public/v/${token}`,
    remoteAddress: '10.31.0.1',
    headers: {
      host: hostOf(world.slug),
      origin: `https://${hostOf(world.slug)}`,
      'user-agent': 'vitest-patient',
    },
  });

describe('the manual link at rest', () => {
  it('is stored encrypted, never in plaintext, and is still followed by the patient and the professional', async () => {
    const { appointment, token } = await inWindow();

    const attached = await world.api.put(
      `/appointments/${appointment.id}/video/manual-link`,
      world.reception,
      { url: LINK },
    );
    expect(attached.statusCode, attached.body).toBe(200);

    const row = await raw(appointment.id);
    expect(row?.manual_link).toBeNull();
    expect(row?.enc).toBeInstanceOf(Buffer);
    expect(row?.enc?.toString('latin1')).not.toContain('zoom.us');
    expect(row?.enc?.toString('latin1')).not.toContain('SECRETPASSCODE');
    const summary = (
      await world.api.get(`/appointments/${appointment.id}/video`, world.reception)
    ).json<{ manual: boolean; hasLink: boolean }>();
    expect(summary).toMatchObject({ manual: true, hasLink: true });
    const patient = await enter(token);
    expect(patient.statusCode).toBe(302);
    expect(patient.headers['location']).toBe(LINK);
    const professional = await world.api.post(
      `/appointments/${appointment.id}/video/join`,
      world.doctor,
      {},
    );
    expect(professional.json<{ url: string }>().url).toBe(LINK);
  });

  it('replaces a link written in plaintext before, the first time it is followed', async () => {
    const { appointment, token } = await inWindow();
    await asTenant(runtime, world.tenant.id, (tx) =>
      tx
        .update(videoSession)
        .set({ manualLink: LINK, manualLinkEnc: null, provider: null })
        .where(eq(videoSession.appointmentId, appointment.id)),
    );

    const patient = await enter(token);

    expect(patient.statusCode).toBe(302);
    expect(patient.headers['location']).toBe(LINK);
    const row = await raw(appointment.id);
    expect(row?.manual_link).toBeNull();
    expect(row?.enc).toBeInstanceOf(Buffer);
    expect(
      (await world.api.get(`/appointments/${appointment.id}/video`, world.reception)).json<{
        manual: boolean;
      }>().manual,
    ).toBe(true);
  });

  it('forgets the link when the appointment moves to a new room', async () => {
    const { appointment } = await inWindow();
    await world.api.put(`/appointments/${appointment.id}/video/manual-link`, world.reception, {
      url: LINK,
    });

    const moved = await world.act(appointment, 'reschedule', world.reception, {
      local: { date: world.monday(week), time: '12:00' },
    });
    expect(moved.statusCode, moved.body).toBe(200);

    const row = await raw(appointment.id);
    expect(row?.manual_link).toBeNull();
    expect(row?.enc).toBeNull();
  });
});
