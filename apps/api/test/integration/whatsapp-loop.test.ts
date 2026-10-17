import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { whatsappDevRoutes } from '../../src/adapters/whatsapp-local/dev-routes.js';
import {
  createLocalWhatsAppControls,
  createLocalWhatsAppSender,
  type LocalWhatsAppControls,
  type LocalWhatsAppSender,
} from '../../src/adapters/whatsapp-local/index.js';
import { appointment } from '../../src/db/schema/scheduling.js';
import {
  loadPreferences,
  recordOptIn,
} from '../../src/modules/notifications/application/preferences.js';
import type { AuditActor } from '../../src/platform/audit/writer.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { DevProvider } from '../../src/platform/local-providers/dev-routes.js';
import { createTestAdapterResolver } from '../support/adapters.js';
import { createRecordingJobClient } from '../support/jobs.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import {
  createOperatorHarness,
  createTestClock,
  operatorSession,
  platformHeaders,
  type OperatorHarness,
  type TestClock,
} from '../support/operator.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';

/**
 * The whole WhatsApp loop on the local simulator: a reminder goes out through the simulator's
 * phone, a delivery receipt and a reply typed into the simulator's console travel through the
 * application's REAL signed webhook, and a "1" confirms the appointment.
 */

const SECRET = 'a-simulator-secret-for-the-loop';
const patientActor: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

let runtime: DbHandle;
let harness: OperatorHarness;
let clock: TestClock;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;
let sender: LocalWhatsAppSender;
let controls: LocalWhatsAppControls;
let app: FastifyInstance;
let cookie: string;
let counter = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  harness = createOperatorHarness();
  clock = createTestClock();
  sender = createLocalWhatsAppSender({ db: runtime.db, appSecret: SECRET });
  controls = createLocalWhatsAppControls(runtime.db);
  const provider: DevProvider = {
    id: 'whatsapp',
    label: 'WhatsApp',
    status: async () => ({ adapter: 'local', mode: await controls.mode() }),
    routes: whatsappDevRoutes({ controls, sender }),
  };
  const jobs = createRecordingJobClient();
  scheduling = await createSchedulingHttpWorld(runtime, {
    slug: 'wa-loop',
    app: {
      operator: { database: harness.db, secrets: harness.secrets },
      clock: clock.read,
      localProviders: { console: true, providers: [provider] },
      adapters: createTestAdapterResolver({ whatsapp: sender }),
      jobs,
    },
  });
  app = scheduling.app;
  notes = createNotificationsWorld(scheduling, { jobs, whatsapp: sender });
  cookie = await operatorSession(app, await harness.addOperator(), clock);
});

afterAll(async () => {
  await scheduling.close();
  await harness.close();
  await runtime.close();
});

beforeEach(async () => {
  notes.setNow(new Date('2031-05-06T12:00:00.000Z'));
  notes.jobs.jobs.length = 0;
  await controls.setMode('ok');
});

const dev = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/operator/dev/whatsapp${url}`,
    headers: platformHeaders(cookie),
    remoteAddress: '10.96.2.1',
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

/** An opted-in patient with a mobile number and no email, whose reminder went out over WhatsApp. */
async function reminded(options: { email?: string | null } = {}) {
  counter += 1;
  const tail = String(30_000_000 + counter);
  const patientId = await notes.patient({
    phone: `11${tail}`,
    email: options.email === undefined ? null : options.email,
  });
  await scheduling.inTenant((tx) =>
    recordOptIn(tx, {
      patientId,
      channel: 'whatsapp',
      source: 'online_booking',
      actor: patientActor,
    }),
  );
  const time = `${String(9 + Math.floor((counter % 8) / 2)).padStart(2, '0')}:${counter % 2 === 0 ? '00' : '30'}`;
  const booked = await notes.book(patientId, 1 + Math.floor(counter / 8), time);
  const messageId = await notes.queue({
    kind: 'reminder',
    channel: 'whatsapp',
    patientId,
    appointmentId: booked.id,
    plannedStartsAt: new Date(booked.startsAt),
    appointmentVersion: booked.version,
    dedupeKey: `loop:${booked.id}:whatsapp`,
  });
  await notes.runAllJobs();
  const sent = await notes.message(messageId);
  return {
    patientId,
    appointment: booked,
    messageId,
    number: `+54911${tail}`,
    providerMessageId: sent.providerMessageId ?? '',
  };
}

const appointmentStatus = async (appointmentId: string) =>
  (
    await scheduling.inTenant((tx) =>
      tx
        .select({ status: appointment.status })
        .from(appointment)
        .where(eq(appointment.id, appointmentId)),
    )
  )[0]?.status;

describe('the WhatsApp loop on the local simulator', () => {
  it('shows the reminder in the simulator, as the patient reads it', async () => {
    const r = await reminded();

    const state = (await dev('GET', '/messages')).json<{
      messages: { number: string; body: string; status: string; providerMessageId: string }[];
      mode: string;
    }>();

    const phone = state.messages.find((message) => message.number === r.number);
    expect(phone).toMatchObject({ status: 'accepted', providerMessageId: r.providerMessageId });
    expect(phone?.body).toContain('le recordamos su turno');
    expect(phone?.body).toContain('Responda 1 para confirmar');
    expect(state.mode).toBe('ok');
  });

  it('delivers a receipt through the signed webhook, and the message log and the phone both show it', async () => {
    const r = await reminded();

    const delivered = await dev('POST', `/messages/${r.providerMessageId}/status`, {
      status: 'delivered',
    });
    const read = await dev('POST', `/messages/${r.providerMessageId}/status`, { status: 'read' });

    expect(delivered.json()).toEqual({ delivered: true });
    expect(read.json()).toEqual({ delivered: true });
    expect(await notes.message(r.messageId)).toMatchObject({ status: 'read' });
    const phone = (await controls.messages(100)).find(
      (message) => message.providerMessageId === r.providerMessageId,
    );
    expect(phone?.status).toBe('read');
  });

  it('confirms the appointment when the patient replies "1" in the simulator', async () => {
    const r = await reminded();
    expect(await appointmentStatus(r.appointment.id)).toBe('scheduled');

    const answer = await dev('POST', '/inbound', { from: r.number, text: '1' });

    expect(answer.json()).toEqual({ delivered: true });
    expect(await appointmentStatus(r.appointment.id)).toBe('confirmed');
    const reply = (await controls.messages(100)).find(
      (message) => message.direction === 'inbound' && message.number === r.number,
    );
    expect(reply).toMatchObject({ body: '1', status: 'received' });
  });

  it('opts the patient out with BAJA, and the simulator shows the single acknowledgment', async () => {
    const r = await reminded();

    await dev('POST', '/inbound', { from: r.number, text: 'BAJA' });

    expect((await scheduling.inTenant((tx) => loadPreferences(tx, r.patientId))).whatsapp).toBe(
      'opted_out',
    );
    const acknowledgments = (await controls.messages(100)).filter(
      (message) =>
        message.direction === 'outbound' &&
        message.number === r.number &&
        message.templateKey === 'optout_ack',
    );
    expect(acknowledgments).toHaveLength(1);
    expect(acknowledgments[0]?.body).toContain('no le enviará más mensajes por WhatsApp');
  });

  it('fails the message from the console and the reminder falls back to email', async () => {
    const r = await reminded({ email: 'respaldo@example.test' });
    notes.email.reset();

    const failed = await dev('POST', `/messages/${r.providerMessageId}/status`, {
      status: 'failed',
      errorCode: 'not_on_whatsapp',
    });

    expect(failed.json()).toEqual({ delivered: true });
    expect(await notes.message(r.messageId)).toMatchObject({
      status: 'failed',
      failureReason: 'not_on_whatsapp',
    });
    await notes.runAllJobs();
    expect(notes.email.sent.map((mail) => mail.to)).toContain('respaldo@example.test');
  });

  it('puts the simulator in an outage from the console and the sender asks to retry later', async () => {
    const down = await dev('PUT', '/mode', { mode: 'down' });

    expect(down.json()).toEqual({ mode: 'down' });
    expect(
      await sender.send({
        templateKey: 'appointment_reminder',
        to: '+5491100002222',
        vars: { name: 'Ana' },
        idempotencyKey: `loop-outage-${crypto.randomUUID()}`,
      }),
    ).toMatchObject({ status: 'retryable' });
    const state = (await dev('GET', '/messages')).json<{ mode: string }>();
    expect(state.mode).toBe('down');
  });

  it('marks a number as unreachable from the console', async () => {
    await dev('PUT', '/unreachable', { number: '+5491100003333', unreachable: true });

    expect(
      await sender.send({
        templateKey: 'appointment_reminder',
        to: '+5491100003333',
        vars: {},
        idempotencyKey: `loop-unreachable-${crypto.randomUUID()}`,
      }),
    ).toEqual({ status: 'rejected', reason: 'not_on_whatsapp' });
    await dev('PUT', '/unreachable', { number: '+5491100003333', unreachable: false });
  });

  it('does nothing for an event about a message the phone does not have', async () => {
    const response = await dev('POST', '/messages/wamid.unknown/status', { status: 'delivered' });

    expect(response.statusCode).toBe(404);
  });

  it('is behind the operator session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/operator/dev/whatsapp/messages',
      headers: platformHeaders(),
      remoteAddress: '10.96.2.2',
    });

    expect(response.statusCode).toBe(401);
  });
});
