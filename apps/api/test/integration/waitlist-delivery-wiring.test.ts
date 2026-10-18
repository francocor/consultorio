import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { createFakeWhatsAppSender } from '../../src/adapters/whatsapp-fake/index.js';
import { message } from '../../src/db/schema/notifications.js';
import { loadConfig } from '../../src/main/config.js';
import { notificationsWiring } from '../../src/main/wiring/notifications.js';
import { waitlistWiring } from '../../src/main/wiring/waitlist.js';
import type { WhatsAppSendRequest } from '../../src/modules/notifications/application/ports.js';
import { recordOptIn } from '../../src/modules/notifications/application/preferences.js';
import { createVideoJoinRegistry } from '../../src/modules/notifications/index.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { JobDefinition } from '../../src/platform/jobs/define-job.js';
import { runPending } from '../support/jobs.js';
import { createScriptedEmail } from '../support/notifications-world.js';
import { createWaitlistWorld, type WaitlistWorld } from '../support/waitlist-world.js';

/**
 * The waitlist and notifications as the worker process wires them (`main/wiring`): an offer goes
 * out through the REAL notifications delivery, over WhatsApp for a patient who opted in and over
 * email otherwise, and is put off to the end of quiet hours. Nothing in this file stands in for
 * the delivery: only the two providers at the very edge are in memory.
 */

const START = new Date('2031-05-05T12:00:00.000Z');
const MINUTE = 60_000;
const actor = { userId: null, actingRole: null, ip: null, userAgent: null, requestId: null };

let runtime: DbHandle;
let world: WaitlistWorld;
let definitions: JobDefinition[];
const email = createScriptedEmail();
const whatsappRequests: WhatsAppSendRequest[] = [];
let mobiles = 0;

/** The key service of the worker comes from this environment: the organization's keys must be its own. */
const KEK = Buffer.alloc(32, 7).toString('base64');
const env = {
  DATABASE_URL: 'postgres://app_rw:placeholder@localhost:5432/app',
  BASE_DOMAIN: 'consultorio.test',
  PLATFORM_HOST: 'platform.consultorio.test',
  KMS_LOCAL_KEK_BASE64: KEK,
};

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createWaitlistWorld(runtime, {
    slug: 'waitlist-wiring',
    now: START,
    keys: createTenantKeys({ kms: createLocalKeyManagement(KEK) }),
  });
  const settings = await world.api.patch('/settings', world.owner, {
    waitlist: { entryExpiryDays: 365 },
  });
  expect(settings.statusCode, settings.body).toBe(200);

  const fakeWhatsApp = createFakeWhatsAppSender();
  const whatsapp = {
    ...fakeWhatsApp,
    send: (request: WhatsAppSendRequest) => {
      whatsappRequests.push(request);
      return fakeWhatsApp.send(request);
    },
  };
  const adapters = {
    forTenant: (_tenant: unknown, port: string) =>
      port === 'email' ? email : port === 'whatsapp' ? whatsapp : undefined,
  };
  const context = {
    config: loadConfig(env),
    adapters: adapters as never,
    email,
    clock: () => world.now(),
    videoJoin: createVideoJoinRegistry(),
  };
  const job = { client: world.jobs, db: runtime.db, metrics: {} as never, log: {} as never };
  // The two modules contribute to the same worker, the way main.ts joins them.
  definitions = [
    ...(waitlistWiring.worker?.(context).jobs?.(job) ?? []),
    ...(notificationsWiring.worker?.(context).jobs?.(job) ?? []),
  ];
});

beforeEach(async () => {
  await world.reset();
  email.reset();
  whatsappRequests.length = 0;
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

/** Runs what is pending in the queue, the way the worker would, until nothing is left to run now. */
async function work(rounds = 6) {
  for (let round = 0; round < rounds; round += 1) {
    if (world.jobs.jobs.every((job) => job.done)) return;
    await runPending(runtime.db, world.jobs, definitions);
  }
}

let week = 0;
async function patientOnTheList(options: { whatsapp: boolean }) {
  mobiles += 1;
  const patientId = await world.patient();
  const phone = `+54911555${String(10_000 + mobiles).slice(1)}`;
  await world.inTenant(async (tx) => {
    await tx.execute(sql`UPDATE patient SET phone = ${phone} WHERE id = ${patientId}`);
    if (options.whatsapp) {
      await recordOptIn(tx, {
        patientId,
        channel: 'whatsapp',
        source: 'patient_email_link',
        actor,
      });
    }
  });
  await world.advance(MINUTE);
  const entry = await world.join(patientId);
  return { patientId, phone, entry };
}

/** An appointment is booked and cancelled: its slot is freed for the waitlist. */
async function freeASlot() {
  week += 1;
  const booked = await world.book(week, '10:00');
  await world.cancel(booked);
}

const messagesOf = (patientId: string) =>
  world.inTenant((tx) =>
    tx
      .select({ kind: message.kind, channel: message.channel, status: message.status })
      .from(message)
      .where(sql`${message.patientId} = ${patientId}`),
  );

describe('an offer from the waitlist, through the notifications module', () => {
  it('goes out over WhatsApp to a patient who opted in, and over nothing else', async () => {
    const { patientId, phone } = await patientOnTheList({ whatsapp: true });
    await freeASlot();

    await work();

    const request = whatsappRequests.at(-1);
    expect(request?.templateKey).toBe('waitlist_offer');
    expect(request?.to).toBe(phone);
    expect(request?.vars['offerUrl']).toMatch(/\/public\/t\/[A-Za-z0-9_-]{43}$/);
    expect(email.sent).toHaveLength(0);
    expect(await messagesOf(patientId)).toEqual([
      { kind: 'waitlist_offer', channel: 'whatsapp', status: 'sent' },
    ]);
  });

  it('goes out over email to a patient who did not opt in to WhatsApp', async () => {
    const { patientId } = await patientOnTheList({ whatsapp: false });
    await freeASlot();

    await work();

    expect(whatsappRequests).toEqual([]);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.text).toMatch(/\/public\/t\/[A-Za-z0-9_-]{43}/);
    expect(await messagesOf(patientId)).toEqual([
      { kind: 'waitlist_offer', channel: 'email', status: 'sent' },
    ]);
  });

  it('is put off in quiet hours and goes out once they end, without counting as a failure', async () => {
    const { patientId, entry } = await patientOnTheList({ whatsapp: false });
    // 22:00 in Buenos Aires: quiet hours.
    await world.setNow(new Date('2031-05-06T01:00:00.000Z'));
    await freeASlot();

    await work();

    expect(email.sent).toHaveLength(0);
    expect(whatsappRequests).toEqual([]);
    expect(await messagesOf(patientId)).toEqual([]);
    // Waiting for the morning is not an undeliverable offer: the entry is still in the automatic line.
    expect(await world.entryRow(entry.id)).toMatchObject({
      status: 'offered',
      manual_contact_only: false,
    });
    expect((await world.offersOf(entry.id))[0]).toMatchObject({ status: 'open' });

    // 08:00 in Buenos Aires: they ended, and the offer is still open.
    await world.setNow(new Date('2031-05-06T11:00:00.000Z'));
    await work();

    expect(email.sent).toHaveLength(1);
    expect(await messagesOf(patientId)).toEqual([
      { kind: 'waitlist_offer', channel: 'email', status: 'sent' },
    ]);
  });

  it('does not count quiet hours that began after the match as an unreachable patient', async () => {
    const { patientId, entry } = await patientOnTheList({ whatsapp: false });
    // 20:55 in Buenos Aires: the slot is matched five minutes before quiet hours begin.
    await world.setNow(new Date('2031-05-05T23:55:00.000Z'));
    await freeASlot();
    await work(1);
    // 21:05: the offer job runs inside quiet hours, and the offer would be over by the morning.
    await world.setNow(new Date('2031-05-06T00:05:00.000Z'));

    await work();

    expect(email.sent).toHaveLength(0);
    expect(await messagesOf(patientId)).toEqual([]);
    expect(await world.entryRow(entry.id)).toMatchObject({ manual_contact_only: false });
    // Reception sees the slot with the real reason.
    expect((await world.callsOf(entry.id))[0]).toMatchObject({ reason: 'quiet_hours' });
  });
});
