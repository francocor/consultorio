import { randomBytes } from 'node:crypto';

import type { AppointmentDto } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { videoSession } from '../../src/db/schema/teleconsultation.js';
import { tenant } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createActionTokens } from '../../src/platform/tokens/index.js';
import { hostOf } from '../support/app.js';
import { asTenant, createTestTenant } from '../support/tenants.js';
import { createSpyProvider, createVideoWorld, type VideoWorld } from '../support/video-world.js';

let runtime: DbHandle;
let world: VideoWorld;
let otherSlug: string;

const MINUTE = 60_000;
let week = 100;
const nextWeek = () => ++week;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createVideoWorld(runtime, { slug: 'video-join' });
  otherSlug = 'video-join-other';
  await createTestTenant(runtime, { slug: otherSlug });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

beforeEach(() => {
  world.forgetPastWork();
  world.useProvider(world.provider);
  world.provider.failWith(null);
});

/** A virtual appointment at 10:00 (13:00 UTC) whose room exists, and a join token for it. */
async function readyAppointment(): Promise<{
  appointment: AppointmentDto;
  room: string;
  token: string;
  startsAt: Date;
  weekIndex: number;
}> {
  const weekIndex = nextWeek();
  const appointment = await world.bookVirtual(weekIndex, '10:00');
  await world.runVideoJobs();
  const room = (await world.roomOf(appointment.id)) ?? '';
  const startsAt = new Date(appointment.startsAt);
  // The kind lets a token live 3 hours at most: issued shortly before the start, it covers the window.
  world.setVideoNow(new Date(startsAt.getTime() - 10 * MINUTE));
  const issued = await asTenant(runtime, world.tenant.id, (tx) =>
    createActionTokens({ clock: () => world.videoNow() }).issue(tx, {
      kind: 'video_join',
      subjectId: appointment.id,
      payload: { room },
      ttlMs: 36 * 60 * MINUTE,
    }),
  );
  return { appointment, room, token: issued.token, startsAt, weekIndex };
}

/** Every visit comes from another address, so the limit per client never decides a test. */
let visitor = 0;
const nextAddress = () => {
  visitor += 1;
  return `10.20.${String(Math.floor(visitor / 250))}.${String((visitor % 250) + 1)}`;
};

const open = (token: string, host = hostOf(world.slug), remoteAddress = nextAddress()) =>
  world.app.inject({
    method: 'GET',
    url: `/public/v/${token}`,
    remoteAddress,
    headers: { host, 'user-agent': 'vitest-patient' },
  });

/**
 * The button of the page: a POST from the page of the same host, as a browser sends a form with no
 * fields (JD-S3 R2-C3: the form content type used to be refused with a 415).
 */
const enter = (
  token: string,
  options: { host?: string; origin?: string | null; remoteAddress?: string } = {},
) => {
  const host = options.host ?? hostOf(world.slug);
  return world.app.inject({
    method: 'POST',
    url: `/public/v/${token}`,
    remoteAddress: options.remoteAddress ?? nextAddress(),
    headers: {
      host,
      'user-agent': 'vitest-patient',
      'content-type': 'application/x-www-form-urlencoded',
      ...(options.origin === null ? {} : { origin: options.origin ?? `https://${host}` }),
    },
    payload: '',
  });
};

const at = (startsAt: Date, minutesFromStart: number) => {
  world.setVideoNow(new Date(startsAt.getTime() + minutesFromStart * MINUTE));
};

describe('the platform join address', () => {
  it('tells an early patient when the session opens, and reveals neither the room nor the provider', async () => {
    const { token, room, startsAt } = await readyAppointment();
    at(startsAt, -60);

    const response = await open(token);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['location']).toBeUndefined();
    expect(response.body).toContain('09:45');
    expect(response.body).not.toContain(room);
    expect(response.body).not.toContain('meet.jit.si');
    // The page has no form (its CSP says form-action none), so `no-referrer` is safe here: the
    // `Origin: null` problem only hits a page that posts back to itself, like the token pages.
    expect(response.body).not.toContain('<form');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('shows the notice about the third-party video service and the missing recording, in es-AR', async () => {
    const { token, startsAt } = await readyAppointment();
    at(startsAt, -60);

    const response = await open(token);

    expect(response.body).toContain('lang="es-AR"');
    expect(response.body).toContain('servicio de videollamada de terceros');
    expect(response.body).toContain('no graba');
  });

  it('opens nothing and records nothing for an early visit, and keeps the link usable', async () => {
    const { token, appointment, startsAt } = await readyAppointment();
    at(startsAt, -60);

    await open(token);
    await open(token);

    expect((await world.sessionOf(appointment.id))?.firstOpenedAt).toBeNull();
    expect(await world.auditsOf('video.link.opened', appointment.id)).toHaveLength(0);
    at(startsAt, -10);
    expect((await enter(token)).statusCode).toBe(302);
  });

  it('only looks when it is opened inside the window: the notice and a button, nothing spent and nothing recorded', async () => {
    const { token, room, appointment, startsAt } = await readyAppointment();
    at(startsAt, -5);

    // A mail scanner opens the link, and so does a preview, and so does the patient.
    const looks = [await open(token), await open(token), await open(token)];

    for (const response of looks) {
      expect(response.statusCode).toBe(200);
      expect(response.headers['location']).toBeUndefined();
      expect(response.body).toContain('Entrar a la videoconsulta');
      expect(response.body).toContain('servicio de videollamada de terceros');
      expect(response.body).toMatch(/<form[^>]*method="post"/i);
      expect(response.body).not.toContain(room);
      expect(response.body).not.toContain('meet.jit.si');
      expect(response.headers['referrer-policy']).toBe('same-origin');
      expect(response.headers['content-security-policy']).not.toContain('form-action');
    }
    expect((await world.sessionOf(appointment.id))?.firstOpenedAt).toBeNull();
    expect(await world.auditsOf('video.link.opened', appointment.id)).toHaveLength(0);
    expect((await enter(token)).statusCode).toBe(302);
  });

  it('forwards to the provider room when the button is pressed inside the window, from 15 minutes before the start', async () => {
    const { token, room, startsAt } = await readyAppointment();
    at(startsAt, -15);

    const response = await enter(token);

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers['location'] as string);
    expect(location.origin).toBe('https://meet.jit.si');
    expect(location.pathname).toBe(`/${room}`);
    expect(location.hash).toContain('config.fileRecordingsEnabled=false');
  });

  it('keeps forwarding while the consultation runs and for 60 minutes after the scheduled end', async () => {
    const { token, startsAt } = await readyAppointment();

    at(startsAt, 40);
    expect((await enter(token)).statusCode).toBe(302);
    // The appointment lasts 30 minutes: the window closes at 90 minutes after the start.
    at(startsAt, 90);
    expect((await enter(token)).statusCode).toBe(302);
  });

  it('refuses the button when the request does not come from the page of the same host', async () => {
    const { token, appointment, startsAt } = await readyAppointment();
    at(startsAt, -5);

    const foreign = await enter(token, { origin: 'https://evil.example' });

    expect(foreign.statusCode).toBe(403);
    expect(foreign.headers['location']).toBeUndefined();
    expect((await world.sessionOf(appointment.id))?.firstOpenedAt).toBeNull();
  });

  it('records that the patient opened the link, once as first and again as last, and audits it without the token', async () => {
    const { token, appointment, startsAt } = await readyAppointment();
    at(startsAt, -5);
    await enter(token);
    at(startsAt, 3);
    await enter(token);

    const session = await world.sessionOf(appointment.id);
    const entries = await world.auditsOf('video.link.opened', appointment.id);

    expect(session?.firstOpenedAt?.toISOString()).toBe(
      new Date(startsAt.getTime() - 5 * MINUTE).toISOString(),
    );
    expect(session?.lastOpenedAt?.toISOString()).toBe(
      new Date(startsAt.getTime() + 3 * MINUTE).toISOString(),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      action: 'video.link.opened',
      outcome: 'allow',
      actorUserId: null,
      resourceType: 'appointment',
      userAgent: 'vitest-patient',
    });
    expect(JSON.stringify(entries)).not.toContain(token);
  });

  it('shows that the session is closed once the window is over', async () => {
    const { token, startsAt } = await readyAppointment();
    at(startsAt, 91);

    const response = await open(token);

    expect(response.statusCode).toBe(410);
    expect(response.headers['location']).toBeUndefined();
    expect(response.body).toContain('finalizó');
  });

  it('says the link is not ready yet, instead of forwarding, when the room is still being created', async () => {
    const appointment = await world.bookVirtual(nextWeek(), '11:00');
    const room = (await world.roomOf(appointment.id)) ?? '';
    const startsAt = new Date(appointment.startsAt);
    at(startsAt, -5);
    const issued = await asTenant(runtime, world.tenant.id, (tx) =>
      createActionTokens({ clock: () => world.videoNow() }).issue(tx, {
        kind: 'video_join',
        subjectId: appointment.id,
        payload: { room },
        ttlMs: 60 * MINUTE,
      }),
    );

    const response = await open(issued.token);

    expect(response.statusCode).toBe(200);
    expect(response.headers['location']).toBeUndefined();
    expect(response.body).toContain('todavía no está disponible');
  });

  it('forwards to the manual link when the session has one', async () => {
    const { token, appointment, startsAt } = await readyAppointment();
    await asTenant(runtime, world.tenant.id, (tx) =>
      tx
        .update(videoSession)
        .set({ manualLink: 'https://meet.google.com/abc-defg-hij', provider: null })
        .where(eq(videoSession.appointmentId, appointment.id)),
    );
    at(startsAt, 1);

    const response = await enter(token);

    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe('https://meet.google.com/abc-defg-hij');
  });
});

describe('a manual link is checked again when somebody follows it (JD-S3 B31)', () => {
  it('does not forward the patient to a host that stopped being allowed after the link was attached', async () => {
    const { token, appointment, startsAt } = await readyAppointment();
    await asTenant(runtime, world.tenant.id, (tx) =>
      tx
        .update(videoSession)
        .set({ manualLink: 'https://meet.google.com/abc-defg-hij', provider: null })
        .where(eq(videoSession.appointmentId, appointment.id)),
    );
    at(startsAt, 1);
    expect((await enter(token)).statusCode).toBe(302);

    // The organization narrows the list of hosts (`VIDEO_ALLOWED_DOMAINS`) after the attachment.
    world.useProvider(createSpyProvider(['zoom.us']));
    const refused = await enter(token);
    const asProfessional = await world.api.post(
      `/appointments/${appointment.id}/video/join`,
      world.doctor,
      {},
    );

    expect(refused.statusCode).toBe(200);
    expect(refused.headers['location']).toBeUndefined();
    expect(refused.body).toContain('todavía no está disponible');
    expect(asProfessional.statusCode, asProfessional.body).toBe(409);
  });
});

describe('abuse of the platform join address', () => {
  it('limits the visits of one client in a minute, whatever the token', async () => {
    const guessed = randomBytes(32).toString('base64url');
    const address = '10.99.99.99';

    const answers: number[] = [];
    for (let attempt = 0; attempt < 32; attempt += 1) {
      answers.push((await open(guessed, hostOf(world.slug), address)).statusCode);
    }

    expect(answers.slice(0, 30)).toEqual(Array<number>(30).fill(404));
    expect(answers.slice(30)).toEqual([429, 429]);
    // Another client is not affected by it.
    expect((await open(guessed)).statusCode).toBe(404);
  });
});

describe('every link that does not work looks the same', () => {
  it('answers a guessed token, a revoked one and a cancelled appointment with one identical page', async () => {
    const guessed = randomBytes(32).toString('base64url');
    const revoked = await readyAppointment();
    const cancelled = await readyAppointment();
    at(revoked.startsAt, -5);
    // The reschedule revokes the address of the previous room.
    const moved = await world.act(revoked.appointment, 'reschedule', world.reception, {
      local: { date: world.monday(revoked.weekIndex), time: '12:00' },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const cancel = await world.act(cancelled.appointment, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'patient_request',
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    at(cancelled.startsAt, -5);

    const guessed404 = await open(guessed);
    const pages = [
      guessed404,
      await open(revoked.token),
      await open(cancelled.token),
      await open('not-a-token'),
    ];

    for (const page of pages) {
      expect(page.statusCode).toBe(404);
      expect(page.headers['location']).toBeUndefined();
      expect(page.body).toBe(guessed404.body);
    }
    expect(guessed404.body).toContain('no está disponible');
  });

  it('does not open one organization link on the host of another', async () => {
    const { token, startsAt } = await readyAppointment();
    at(startsAt, -5);

    const response = await open(token, hostOf(otherSlug));

    expect(response.statusCode).toBe(404);
    expect(response.headers['location']).toBeUndefined();
  });

  it('refuses to forward a link whose room is not the one of the appointment', async () => {
    const { appointment, startsAt } = await readyAppointment();
    at(startsAt, -5);
    const stale = await asTenant(runtime, world.tenant.id, (tx) =>
      createActionTokens({ clock: () => world.videoNow() }).issue(tx, {
        kind: 'video_join',
        subjectId: appointment.id,
        payload: { room: 'ffffffffffffffffffffffffffffffff' },
        ttlMs: 60 * MINUTE,
      }),
    );

    const response = await open(stale.token);

    expect(response.statusCode).toBe(404);
    expect(response.headers['location']).toBeUndefined();
  });

  it('looks like a disabled link when the organization is read-only, and records nothing', async () => {
    const { token, appointment, startsAt } = await readyAppointment();
    at(startsAt, -5);
    const setStatus = (status: 'active' | 'read_only') =>
      asTenant(runtime, world.tenant.id, (tx) =>
        tx
          .update(tenant)
          .set({ status, readOnlySince: status === 'read_only' ? new Date() : null })
          .where(eq(tenant.id, world.tenant.id)),
      );
    await setStatus('read_only');
    try {
      const response = await open(token);

      expect(response.statusCode).toBe(404);
      expect(response.headers['location']).toBeUndefined();
      expect((await world.sessionOf(appointment.id))?.firstOpenedAt).toBeNull();
    } finally {
      await setStatus('active');
    }
  });
});
