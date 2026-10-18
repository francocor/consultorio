import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createFakeWhatsAppSender } from '../../src/adapters/whatsapp-fake/index.js';
import { message, messageOffer } from '../../src/db/schema/notifications.js';
import { readOfferUrl } from '../../src/modules/notifications/application/offer-facts.js';
import type {
  WhatsAppSender,
  WhatsAppSendRequest,
  WhatsAppSendResult,
} from '../../src/modules/notifications/application/ports.js';
import {
  recordOptIn,
  recordOptOut,
} from '../../src/modules/notifications/application/preferences.js';
import { createReminderSweepJob } from '../../src/modules/notifications/application/sweep.js';
import type { QuotaPolicy } from '../../src/modules/notifications/application/usage.js';
import {
  bindOfferDelivery,
  deliverWaitlistOffer,
  offerQuietHoursEnd,
  type WaitlistOfferInput,
} from '../../src/modules/notifications/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import { insertLocation, insertPatient, insertProfessional } from '../support/fixture-helpers.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

/**
 * The delivery entry point of the waitlist (`deliverWaitlistOffer`): the offer is written from
 * the slot it offers, goes by the channel the patient allows, and respects opt-outs, quotas, quiet
 * hours and the organizations that never send.
 */

const actor = { userId: null, actingRole: null, ip: null, userAgent: null, requestId: null };
const OFFER_URL = 'https://offers.example.test/public/t/OFFER-TOKEN';

/** A WhatsApp provider whose answer a test chooses. */
interface ScriptedWhatsApp extends WhatsAppSender {
  readonly requests: WhatsAppSendRequest[];
  answer: WhatsAppSendResult | null;
}

function createScriptedWhatsApp(): ScriptedWhatsApp {
  const base = createFakeWhatsAppSender();
  const requests: WhatsAppSendRequest[] = [];
  const sender: ScriptedWhatsApp = {
    requests,
    answer: null,
    send(request) {
      requests.push(request);
      return sender.answer ? Promise.resolve(sender.answer) : base.send(request);
    },
    verifyWebhook: (...args) => base.verifyWebhook(...args),
    parseEvents: (body) => base.parseEvents(body),
  };
  return sender;
}

let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;
let whatsapp: ScriptedWhatsApp;
let quota: QuotaPolicy | undefined;
let slot = 0;
let mobiles = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  scheduling = await createSchedulingHttpWorld(runtime, { slug: 'notif-offers' });
  whatsapp = createScriptedWhatsApp();
  notes = createNotificationsWorld(scheduling, { whatsapp });
});

afterAll(async () => {
  await scheduling.close();
  await runtime.close();
});

beforeEach(async () => {
  // 12:00 local on a Tuesday: not in quiet hours.
  notes.setNow(new Date('2031-05-06T15:00:00.000Z'));
  notes.jobs.jobs.length = 0;
  notes.email.reset();
  notes.demoEmail.clear();
  whatsapp.requests.length = 0;
  whatsapp.answer = null;
  quota = undefined;
  await notes.setTenant({ status: 'active' });
  bindOfferDelivery({
    jobs: notes.jobs,
    clock: () => notes.now(),
    whatsappAvailable: () => true,
    keys: scheduling.keys,
    get quota() {
      return quota;
    },
  });
});

/** An Argentine mobile number nobody used in this file. */
const mobile = () =>
  `+54911555${String(10_000 + ++mobiles)
    .slice(1)
    .padStart(5, '0')}`.slice(0, 14);

/** The input for an offer of a slot on a Monday of its own, expiring 30 minutes from now. */
function offerFor(
  patientId: string,
  overrides: Partial<WaitlistOfferInput> = {},
): WaitlistOfferInput {
  slot += 1;
  const startsAt = new Date(`2031-06-${String(10 + (slot % 15)).padStart(2, '0')}T13:00:00.000Z`);
  return {
    offerId: crypto.randomUUID(),
    patientId,
    professionalId: scheduling.doctor.professionalId,
    locationId: scheduling.centro,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    expiresAt: new Date(notes.now().getTime() + 30 * 60_000),
    offerTokenUrl: OFFER_URL,
    ...overrides,
  };
}

const deliver = (input: WaitlistOfferInput) =>
  scheduling.inTenant((tx) => deliverWaitlistOffer(tx, input));

const offerMessages = (patientId: string) =>
  scheduling.inTenant((tx) => tx.select().from(message).where(eq(message.patientId, patientId)));

describe('deliverWaitlistOffer: the channel', () => {
  it('sends the offer by email to a patient with an email, and logs the message', async () => {
    const patientId = await notes.patient({ email: 'espera@example.test' });
    const input = offerFor(patientId);

    const result = await deliver(input);
    await notes.runAllJobs();

    expect(result.channel).toBe('email');
    expect(result.messageId).toEqual(expect.any(String));
    const sent = notes.email.sent.at(-1);
    expect(sent?.to).toBe('espera@example.test');
    expect(sent?.subject).toMatch(/^Hay un turno disponible en /);
    expect(sent?.text).toContain(OFFER_URL);
    expect(sent?.text).toContain('Hola Ana:');
    expect(sent?.text).toContain('Hora: 10:00');
    expect(sent?.text).toContain('antes de las 12:30:');
    expect(sent?.text).toContain('/public/t/');
    const [logged] = await offerMessages(patientId);
    expect(logged).toMatchObject({
      id: result.messageId,
      kind: 'waitlist_offer',
      channel: 'email',
      status: 'sent',
      appointmentId: null,
      professionalId: scheduling.doctor.professionalId,
    });
  });

  it('keeps the link out of the message log', async () => {
    const patientId = await notes.patient({ email: 'log@example.test' });
    await deliver(offerFor(patientId));

    const rows = await offerMessages(patientId);

    expect(JSON.stringify(rows)).not.toContain('OFFER-TOKEN');
  });

  it('sends it by WhatsApp to a patient who opted in, with the address in the message', async () => {
    const phone = mobile();
    const patientId = await notes.patient({ email: 'wa@example.test', phone });
    await scheduling.inTenant((tx) =>
      recordOptIn(tx, { patientId, channel: 'whatsapp', source: 'patient_email_link', actor }),
    );

    const result = await deliver(offerFor(patientId));
    await notes.runAllJobs();

    expect(result.channel).toBe('whatsapp');
    const request = whatsapp.requests.at(-1);
    expect(request?.templateKey).toBe('waitlist_offer');
    expect(request?.to).toBe(phone);
    expect(request?.vars['offerUrl']).toBe(OFFER_URL);
    expect(request?.vars['offerExpires']).toBe('12:30');
    expect(notes.email.sent).toHaveLength(0);
  });

  it('goes by email only when the patient opted out of WhatsApp', async () => {
    const patientId = await notes.patient({ email: 'baja@example.test', phone: mobile() });
    await scheduling.inTenant(async (tx) => {
      await recordOptIn(tx, { patientId, channel: 'whatsapp', source: 'online_booking', actor });
      await recordOptOut(tx, { patientId, channel: 'whatsapp', source: 'whatsapp_keyword', actor });
    });

    const result = await deliver(offerFor(patientId));

    expect(result.channel).toBe('email');
  });

  it('does not use WhatsApp without an opt-in', async () => {
    const patientId = await notes.patient({ email: 'sin@example.test', phone: mobile() });

    const result = await deliver(offerFor(patientId));

    expect(result.channel).toBe('email');
  });

  it('sends nothing when the patient opted out of every channel they can be reached on', async () => {
    const patientId = await notes.patient({ email: 'nada@example.test' });
    await scheduling.inTenant((tx) =>
      recordOptOut(tx, { patientId, channel: 'email', source: 'email_link', actor }),
    );

    const result = await deliver(offerFor(patientId));

    expect(result).toEqual({ channel: 'none', messageId: null });
    expect(await offerMessages(patientId)).toEqual([]);
  });

  it('answers "none" for a patient with no contact at all', async () => {
    const patientId = await notes.patient({ email: null, phone: null });

    expect(await deliver(offerFor(patientId))).toEqual({ channel: 'none', messageId: null });
  });

  it('falls back to email when the WhatsApp quota of the professional is spent', async () => {
    const patientId = await notes.patient({ email: 'cupo@example.test', phone: mobile() });
    await scheduling.inTenant((tx) =>
      recordOptIn(tx, { patientId, channel: 'whatsapp', source: 'online_booking', actor }),
    );
    // The plan allows no messages and no overage.
    quota = { limitFor: () => Promise.resolve({ limit: 0, overageAllowed: false }) };

    const result = await deliver(offerFor(patientId));

    expect(result.channel).toBe('email');
  });
});

describe('deliverWaitlistOffer: when it must not send', () => {
  it('does not send during quiet hours, and tells when they end', async () => {
    const patientId = await notes.patient({ email: 'noche@example.test' });
    // 22:00 in Buenos Aires.
    notes.setNow(new Date('2031-05-07T01:00:00.000Z'));
    const input = offerFor(patientId, { expiresAt: new Date('2031-05-07T01:30:00.000Z') });

    const result = await deliver(input);
    const ends = await scheduling.inTenant((tx) =>
      offerQuietHoursEnd(tx, { locationId: scheduling.centro, at: notes.now() }),
    );

    expect(result).toEqual({ channel: 'none', messageId: null });
    expect(await offerMessages(patientId)).toEqual([]);
    expect(ends).toEqual(new Date('2031-05-07T11:00:00.000Z'));
  });

  it('says there are no quiet hours at midday', async () => {
    const ends = await scheduling.inTenant((tx) =>
      offerQuietHoursEnd(tx, { locationId: scheduling.centro, at: notes.now() }),
    );

    expect(ends).toBeNull();
  });

  it('does not send while the organization is read-only', async () => {
    const patientId = await notes.patient({ email: 'solo@example.test' });
    await notes.setTenant({ status: 'read_only' });

    const result = await deliver(offerFor(patientId));

    expect(result).toEqual({ channel: 'none', messageId: null });
    expect(await offerMessages(patientId)).toEqual([]);
  });

  it('never reaches a patient of a demonstration organization', async () => {
    const demo = await createTestTenant(runtime, { slug: 'notif-offers-demo', isDemo: true });
    const result = await asTenant(runtime, demo.id, async (tx) => {
      const patientId = await insertPatient(tx, demo.id);
      await tx.execute(sql`UPDATE patient SET email = 'demo@example.test' WHERE id = ${patientId}`);
      const locationId = await insertLocation(tx, demo.id);
      const professionalId = await insertProfessional(tx, demo.id);
      const input = offerFor(patientId, { locationId, professionalId });
      const delivered = await deliverWaitlistOffer(tx, input);
      const logged = await tx.select().from(message).where(eq(message.patientId, patientId));
      return { delivered, logged };
    });

    expect(result.delivered).toEqual({ channel: 'none', messageId: null });
    expect(result.logged).toEqual([]);
  });

  it('does not send an offer that has already expired', async () => {
    const patientId = await notes.patient({ email: 'tarde@example.test' });
    const input = offerFor(patientId, { expiresAt: new Date(notes.now().getTime() - 1) });

    expect(await deliver(input)).toEqual({ channel: 'none', messageId: null });
  });

  it('answers "none" when notifications has no queue to send with', async () => {
    const patientId = await notes.patient({ email: 'sincola@example.test' });
    bindOfferDelivery(undefined);

    expect(await deliver(offerFor(patientId))).toEqual({ channel: 'none', messageId: null });
  });

  it('cancels the message when the offer expired before the job ran', async () => {
    const patientId = await notes.patient({ email: 'vencida@example.test' });
    const input = offerFor(patientId);
    const result = await deliver(input);

    notes.setNow(new Date(input.expiresAt.getTime() + 60_000));
    await notes.runAllJobs();

    expect(notes.email.sent).toHaveLength(0);
    expect(await notes.message(result.messageId ?? '')).toMatchObject({
      status: 'cancelled',
      cancelReason: 'offer_expired',
    });
  });

  it('cancels the message when the patient opted out after the offer was queued', async () => {
    const patientId = await notes.patient({ email: 'despues@example.test' });
    const result = await deliver(offerFor(patientId));
    await scheduling.inTenant((tx) =>
      recordOptOut(tx, { patientId, channel: 'email', source: 'email_link', actor }),
    );

    await notes.runAllJobs();

    expect(notes.email.sent).toHaveLength(0);
    expect(await notes.message(result.messageId ?? '')).toMatchObject({
      status: 'cancelled',
      cancelReason: 'opted_out',
    });
  });
});

describe('deliverWaitlistOffer: one offer, one message', () => {
  it('returns the same message when it is asked twice for the same offer', async () => {
    const patientId = await notes.patient({ email: 'dos@example.test' });
    const input = offerFor(patientId);

    const first = await deliver(input);
    const second = await deliver(input);
    await notes.runAllJobs();

    expect(second).toEqual(first);
    expect(await offerMessages(patientId)).toHaveLength(1);
    expect(notes.email.sent).toHaveLength(1);
  });

  it('sends the offer by email, with its link, when WhatsApp refuses the number for good', async () => {
    const patientId = await notes.patient({ email: 'caida@example.test', phone: mobile() });
    await scheduling.inTenant((tx) =>
      recordOptIn(tx, { patientId, channel: 'whatsapp', source: 'online_booking', actor }),
    );
    whatsapp.answer = { status: 'rejected', reason: 'not_on_whatsapp' };

    const result = await deliver(offerFor(patientId));
    await notes.runAllJobs();

    expect(result.channel).toBe('whatsapp');
    expect(notes.email.sent.at(-1)?.text).toContain(OFFER_URL);
    const rows = await offerMessages(patientId);
    expect(rows.map((row) => `${row.channel}:${row.status}`).sort()).toEqual([
      'email:sent',
      'whatsapp:failed',
    ]);
  });
});

describe('the link of an offer', () => {
  const sweep = () =>
    runJob(runtime.db, createReminderSweepJob({ ...notes.deps }), {
      id: crypto.randomUUID(),
      name: 'reminder.sweep',
      data: { tenantId: scheduling.tenant.id },
      enqueuedAt: notes.now(),
      retryCount: 0,
    });

  const urlOf = (messageId: string) =>
    scheduling.inTenant(async (tx) => {
      const [row] = await tx
        .select()
        .from(messageOffer)
        .where(eq(messageOffer.messageId, messageId));
      return row ? readOfferUrl(tx, scheduling.keys, row) : null;
    });

  it('rests encrypted, not in plaintext, and is read back for the message that carries it (JD-S3 C9)', async () => {
    const patientId = await notes.patient({ email: 'cifrado@example.test' });
    const { messageId } = await deliver(offerFor(patientId));

    const [row] = await scheduling.inTenant((tx) =>
      tx
        .select()
        .from(messageOffer)
        .where(eq(messageOffer.messageId, messageId ?? '')),
    );

    expect(row?.url).toBeNull();
    expect(row?.urlEnc).toBeInstanceOf(Buffer);
    expect(row?.urlEnc?.toString('latin1')).not.toContain('OFFER-TOKEN');
    expect(await urlOf(messageId ?? '')).toBe(OFFER_URL);
    await notes.runAllJobs();
    expect(notes.email.sent.at(-1)?.text).toContain(OFFER_URL);
  });

  it('is cleared by the sweep an hour after the offer expired, and not before', async () => {
    const patientId = await notes.patient({ email: 'limpieza@example.test' });
    const input = offerFor(patientId);
    const { messageId } = await deliver(input);
    await notes.runAllJobs();

    notes.setNow(new Date(input.expiresAt.getTime() + 30 * 60_000));
    await sweep();
    const early = await urlOf(messageId ?? '');
    notes.setNow(new Date(input.expiresAt.getTime() + 61 * 60_000));
    await sweep();
    const late = await urlOf(messageId ?? '');

    expect(early).toBe(OFFER_URL);
    expect(late).toBeNull();
  });
});
