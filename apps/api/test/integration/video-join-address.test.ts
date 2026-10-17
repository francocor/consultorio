import type { AppointmentDto } from '@consultorio/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { VideoJoinAddress } from '../../src/modules/teleconsultation/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { hostOf } from '../support/app.js';
import { createTestTenant } from '../support/tenants.js';
import { createVideoWorld, type VideoWorld } from '../support/video-world.js';

let runtime: DbHandle;
let world: VideoWorld;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
let week = 400;
const nextWeek = () => ++week;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createVideoWorld(runtime, { slug: 'video-address' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

beforeEach(() => {
  world.forgetPastWork();
  world.useProvider(world.provider);
});

const resolve = (appointmentId: string): Promise<VideoJoinAddress> =>
  world.inTenant((tx) => world.joinUrlResolver().resolve(tx, appointmentId));

/** A ready virtual appointment (10:00 local); the video clock stands `minutes` from its start. */
async function ready(minutesFromStart: number): Promise<AppointmentDto> {
  const created = await world.bookVirtual(nextWeek(), '10:00');
  await world.runVideoJobs();
  world.setVideoNow(new Date(new Date(created.startsAt).getTime() + minutesFromStart * MINUTE));
  return created;
}

function pathOf(address: VideoJoinAddress): string {
  if (address.kind !== 'link') throw new Error(`expected a link, got ${address.kind}`);
  return new URL(address.url).pathname;
}

describe('the address a reminder carries for a virtual appointment', () => {
  it('is the platform join address on the organization host, never the provider address', async () => {
    const created = await ready(-120);
    const room = (await world.roomOf(created.id)) ?? '';

    const address = await resolve(created.id);

    expect(address.kind).toBe('link');
    if (address.kind !== 'link') return;
    const url = new URL(address.url);
    expect(url.host).toBe(hostOf(world.slug));
    expect(url.pathname).toMatch(/^\/public\/v\/[A-Za-z0-9_-]{43}$/);
    expect(address.url).not.toContain(room);
    expect(address.url).not.toContain('jit.si');
  });

  it('works when the patient opens it, early and inside the window', async () => {
    const created = await ready(-10);
    const address = await resolve(created.id);
    const path = pathOf(address);
    const open = () =>
      world.app.inject({ method: 'GET', url: path, headers: { host: hostOf(world.slug) } });

    const inside = await open();
    world.setVideoNow(new Date(new Date(created.startsAt).getTime() - HOUR));
    const early = await open();

    expect(inside.statusCode).toBe(302);
    expect(inside.headers['location']).toContain('https://meet.jit.si/');
    expect(early.statusCode).toBe(200);
    expect(early.body).toContain('09:45');
  });

  it('gives each reminder an address of its own, and all of them work', async () => {
    const created = await ready(-10);

    const first = pathOf(await resolve(created.id));
    const second = pathOf(await resolve(created.id));

    expect(first).not.toBe(second);
    for (const path of [first, second]) {
      const response = await world.app.inject({
        method: 'GET',
        url: path,
        headers: { host: hostOf(world.slug) },
      });
      expect(response.statusCode).toBe(302);
    }
  });

  it('asks for a lifetime that covers the join window, which the kind caps at three hours', async () => {
    const created = await ready(-10);
    const now = world.videoNow().getTime();

    const address = await resolve(created.id);

    if (address.kind !== 'link') throw new Error('expected a link');
    // The window closes 90 minutes after the start and the page stays reachable 12 hours more, but
    // the kind lets a token live 3 hours at most (see the risks of S3.14).
    expect(address.expiresAt.getTime()).toBe(now + 3 * HOUR);
  });

  it('says the link follows while the room is pending, so the reminder can say so', async () => {
    const created = await world.bookVirtual(nextWeek(), '11:00');

    expect(await resolve(created.id)).toEqual({ kind: 'pending' });
  });

  it('has no address for an appointment in person', async () => {
    const created = await world.book(nextWeek(), '12:00');

    expect(await resolve(created.id)).toEqual({ kind: 'in_person' });
  });

  it('has no address for a cancelled appointment, and none after the window closed', async () => {
    const cancelled = await ready(-10);
    await world.act(cancelled, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'patient_request',
    });
    const over = await ready(24 * 60);

    expect(await resolve(cancelled.id)).toEqual({ kind: 'closed' });
    expect(await resolve(over.id)).toEqual({ kind: 'closed' });
  });

  it('is what the simulator console hands out as the reminder of an appointment', async () => {
    const created = await ready(-10);

    const address = await world.devControls().issuePatientLink({
      tenantId: world.tenant.id,
      appointmentId: created.id,
    });

    expect(address.kind).toBe('link');
    const response = await world.app.inject({
      method: 'GET',
      url: pathOf(address),
      headers: { host: hostOf(world.slug) },
    });
    expect(response.statusCode).toBe(302);
  });

  it('is nothing for an appointment of another organization, even through the console', async () => {
    const created = await ready(-10);
    const other = await createTestTenant(runtime, { slug: 'video-address-other' });

    const address = await world.devControls().issuePatientLink({
      tenantId: other.id,
      appointmentId: created.id,
    });

    expect(address).toEqual({ kind: 'in_person' });
  });

  it('is the manual link of the appointment when the professional attached one', async () => {
    const created = await ready(-10);
    await world.api.put(`/appointments/${created.id}/video/manual-link`, world.doctor, {
      url: 'https://zoom.us/j/123456789',
    });

    const path = pathOf(await resolve(created.id));
    const response = await world.app.inject({
      method: 'GET',
      url: path,
      headers: { host: hostOf(world.slug) },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe('https://zoom.us/j/123456789');
  });
});
