import type { PatientChannelsResponse } from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createFakeEmailSender } from '../../src/adapters/fake-email/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { channelPreference } from '../../src/db/schema/channel-preference.js';
import { recordOptOut } from '../../src/modules/notifications/application/preferences.js';
import type { AuditActor } from '../../src/platform/audit/writer.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { browserHeaders } from '../support/app.js';
import { insertPatient } from '../support/fixture-helpers.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

/** What reception does about the channels of a patient, and the opt-in by an emailed link. */

const SLUG = 'notif-channels';
const patientActor: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;
const mailbox = createFakeEmailSender();

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  scheduling = await createSchedulingHttpWorld(runtime, { slug: SLUG, app: { email: mailbox } });
  notes = createNotificationsWorld(scheduling);
});

afterAll(async () => {
  await scheduling.close();
  await runtime.close();
});

beforeEach(async () => {
  mailbox.clear();
  await notes.setTenant({ status: 'active' });
});

const channels = async (patientId: string, as = scheduling.reception) => {
  const response = await scheduling.api.get(`/patients/${patientId}/channels`, as);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<PatientChannelsResponse>();
};

const view = (method: 'GET' | 'POST', path: string) =>
  scheduling.app.inject({ method, url: path, headers: browserHeaders(SLUG) });

describe('the channels of a patient', () => {
  it('starts as "email on, WhatsApp off" and tells whether there is a way to reach them', async () => {
    const complete = await notes.patient({ email: 'a@example.test', phone: '1144445555' });
    const bare = await notes.patient({ email: null, phone: null });

    expect(await channels(complete)).toEqual({
      email: { state: 'default', source: null, recordedAt: null },
      whatsapp: { state: 'none', source: null, recordedAt: null },
      hasEmail: true,
      hasMobile: true,
    });
    expect(await channels(bare)).toMatchObject({ hasEmail: false, hasMobile: false });
  });

  it('says the phone is not usable when it cannot be read as a mobile number', async () => {
    const landline = await notes.patient({ phone: '4444-5555' });

    expect((await channels(landline)).hasMobile).toBe(false);
  });

  it('is not found for a patient of another organization', async () => {
    const other = await createTestTenant(runtime, {
      slug: `notif-channels-x-${crypto.randomUUID().slice(0, 6)}`,
    });
    const foreign = await asTenant(runtime, other.id, (tx) => insertPatient(tx, other.id));

    const response = await scheduling.api.get(
      `/patients/${foreign}/channels`,
      scheduling.reception,
    );
    const optOut = await scheduling.api.post(
      `/patients/${foreign}/channels/email/opt-out`,
      scheduling.reception,
      {},
    );

    expect(response.statusCode).toBe(404);
    expect(optOut.statusCode).toBe(404);
  });
});

describe('recording a choice in person', () => {
  it('records a WhatsApp opt-in for the patient, with the source and the staff member, and audits it', async () => {
    const patientId = await notes.patient({ phone: '1144445555' });

    const response = await scheduling.api.post(
      `/patients/${patientId}/channels/whatsapp/opt-in`,
      scheduling.reception,
      {},
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PatientChannelsResponse>().whatsapp).toMatchObject({
      state: 'opted_in',
      source: 'staff',
    });
    const [row] = await scheduling.inTenant((tx) =>
      tx.select().from(channelPreference).where(eq(channelPreference.patientId, patientId)),
    );
    expect(row).toMatchObject({ source: 'staff', recordedBy: scheduling.reception.user.id });
    const audits = await scheduling.inTenant((tx) =>
      tx
        .select({ metadata: auditEvent.metadata, actor: auditEvent.actorUserId })
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.patientId, patientId),
            eq(auditEvent.action, 'notification.optin.recorded'),
          ),
        ),
    );
    expect(audits).toEqual([
      { metadata: { channel: 'whatsapp', source: 'staff' }, actor: scheduling.reception.user.id },
    ]);
  });

  it('refuses a WhatsApp opt-in for a patient with no mobile number', async () => {
    const patientId = await notes.patient({ phone: null });

    const response = await scheduling.api.post(
      `/patients/${patientId}/channels/whatsapp/opt-in`,
      scheduling.reception,
      {},
    );

    expect(response.statusCode).toBe(422);
    expect(response.json<{ code: string }>().code).toBe('patient_without_phone');
  });

  it('records an opt-out the patient gave in person, and cancels what was queued on that channel', async () => {
    const patientId = await notes.patient({ email: 'baja@example.test' });
    const booked = await notes.book(patientId, 40, '09:00');
    const queued = await notes.queue({
      kind: 'reminder',
      patientId,
      appointmentId: booked.id,
      plannedStartsAt: new Date(booked.startsAt),
      appointmentVersion: booked.version,
      dedupeKey: `channels:${booked.id}:email`,
    });

    const response = await scheduling.api.post(
      `/patients/${patientId}/channels/email/opt-out`,
      scheduling.reception,
      {},
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PatientChannelsResponse>().email).toMatchObject({
      state: 'opted_out',
      source: 'staff',
    });
    expect(await notes.message(queued)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'opted_out',
    });
  });

  it('refuses to switch back on a channel the patient switched off, and says why', async () => {
    const patientId = await notes.patient({ email: 'no@example.test', phone: '1144445555' });
    await scheduling.inTenant((tx) =>
      recordOptOut(tx, {
        patientId,
        channel: 'whatsapp',
        source: 'whatsapp_keyword',
        actor: patientActor,
      }),
    );
    await scheduling.inTenant((tx) =>
      recordOptOut(tx, { patientId, channel: 'email', source: 'email_link', actor: patientActor }),
    );

    for (const channel of ['whatsapp', 'email']) {
      const response = await scheduling.api.post(
        `/patients/${patientId}/channels/${channel}/opt-in`,
        scheduling.reception,
        {},
      );
      expect(response.statusCode, channel).toBe(409);
      expect(response.json<{ code: string }>().code, channel).toBe('channel_opted_out');
    }
    expect(await channels(patientId)).toMatchObject({
      email: { state: 'opted_out' },
      whatsapp: { state: 'opted_out' },
    });
  });

  it('is not found for a patient who is not in the organization', async () => {
    const response = await scheduling.api.post(
      `/patients/${crypto.randomUUID()}/channels/email/opt-out`,
      scheduling.reception,
      {},
    );

    expect(response.statusCode).toBe(404);
  });

  it('needs a signed-in user', async () => {
    const patientId = await notes.patient();

    const response = await scheduling.api.post(
      `/patients/${patientId}/channels/email/opt-out`,
      null,
      {},
    );

    expect(response.statusCode).toBe(401);
  });
});

describe('the WhatsApp opt-in by email', () => {
  const requestLink = async (patientId: string) => {
    const response = await scheduling.api.post(
      `/patients/${patientId}/whatsapp-opt-in-request`,
      scheduling.reception,
      {},
    );
    expect(response.statusCode, response.body).toBe(200);
    const mail = mailbox.lastTo('optin@example.test');
    return { mail, path: new URL(mailbox.linkIn(mail) ?? 'http://x/').pathname };
  };

  it('emails the patient a single-purpose link, and accepting it records the opt-in from the patient', async () => {
    const patientId = await notes.patient({ email: 'optin@example.test', phone: '1144445555' });

    const { mail, path } = await requestLink(patientId);

    expect(mail?.subject).toContain('Recordatorios de turnos por WhatsApp');
    expect(mail?.text).toContain('Hola Ana:');
    expect(path).toMatch(/^\/public\/t\/[A-Za-z0-9_-]{43}$/);

    const page = await view('GET', path);
    expect(page.body).toContain('Aceptar recordatorios por WhatsApp');
    expect((await channels(patientId)).whatsapp.state).toBe('none');

    const accepted = await view('POST', path);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body).toContain('Listo: recibirá recordatorios por WhatsApp');
    expect((await channels(patientId)).whatsapp).toMatchObject({
      state: 'opted_in',
      source: 'patient_email_link',
    });
    const [row] = await scheduling.inTenant((tx) =>
      tx.select().from(channelPreference).where(eq(channelPreference.patientId, patientId)),
    );
    expect(row?.recordedBy).toBeNull();
    expect((await view('POST', path)).statusCode).toBe(404);
  });

  it('is refused for a patient with no email, or with no mobile number', async () => {
    const noEmail = await notes.patient({ email: null, phone: '1144445555' });
    const noPhone = await notes.patient({ email: 'x@example.test', phone: null });

    const first = await scheduling.api.post(
      `/patients/${noEmail}/whatsapp-opt-in-request`,
      scheduling.reception,
      {},
    );
    const second = await scheduling.api.post(
      `/patients/${noPhone}/whatsapp-opt-in-request`,
      scheduling.reception,
      {},
    );

    expect(first.statusCode).toBe(422);
    expect(first.json<{ code: string }>().code).toBe('patient_without_email');
    expect(second.statusCode).toBe(422);
    expect(second.json<{ code: string }>().code).toBe('patient_without_phone');
    expect(mailbox.sent).toEqual([]);
  });

  it('is refused for a patient who opted out of email, and sends nothing (JD-S3 A7)', async () => {
    const patientId = await notes.patient({ email: 'optin@example.test', phone: '1144445555' });
    await scheduling.inTenant((tx) =>
      recordOptOut(tx, { patientId, channel: 'email', source: 'email_link', actor: patientActor }),
    );
    mailbox.clear();

    const response = await scheduling.api.post(
      `/patients/${patientId}/whatsapp-opt-in-request`,
      scheduling.reception,
      {},
    );

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('channel_opted_out');
    expect(mailbox.sent).toEqual([]);
  });

  it('replaces an older link with the newer one', async () => {
    const patientId = await notes.patient({ email: 'optin@example.test', phone: '1144445555' });
    const first = await requestLink(patientId);
    mailbox.clear();
    const second = await requestLink(patientId);

    expect((await view('GET', first.path)).statusCode).toBe(404);
    expect((await view('GET', second.path)).statusCode).toBe(200);
  });

  it('does not ask a patient who already accepted', async () => {
    const patientId = await notes.patient({ email: 'optin@example.test', phone: '1144445555' });
    await scheduling.api.post(
      `/patients/${patientId}/channels/whatsapp/opt-in`,
      scheduling.reception,
      {},
    );

    const response = await scheduling.api.post(
      `/patients/${patientId}/whatsapp-opt-in-request`,
      scheduling.reception,
      {},
    );

    expect(response.statusCode).toBe(409);
    expect(mailbox.sent).toEqual([]);
  });

  it('lets the patient come back with their own link after opting out (staff could not)', async () => {
    const patientId = await notes.patient({ email: 'optin@example.test', phone: '1144445555' });
    await scheduling.inTenant((tx) =>
      recordOptOut(tx, {
        patientId,
        channel: 'whatsapp',
        source: 'whatsapp_keyword',
        actor: patientActor,
      }),
    );
    const { path } = await requestLink(patientId);

    const accepted = await view('POST', path);

    expect(accepted.statusCode).toBe(200);
    expect((await channels(patientId)).whatsapp.state).toBe('opted_in');
  });

  it('is not available in a read-only organization', async () => {
    const patientId = await notes.patient({ email: 'optin@example.test', phone: '1144445555' });
    const { path } = await requestLink(patientId);
    await notes.setTenant({ status: 'read_only' });

    const refused = await view('POST', path);

    expect(refused.statusCode).toBe(402);
    await notes.setTenant({ status: 'active' });
    expect((await channels(patientId)).whatsapp.state).toBe('none');
  });
});
