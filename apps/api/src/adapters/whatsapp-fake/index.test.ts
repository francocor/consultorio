import { describe, expect, it } from 'vitest';

import { describeWhatsAppContract } from '../whatsapp-local/whatsapp.contract.js';

import { createFakeWhatsAppSender } from './index.js';

describeWhatsAppContract({
  name: 'in-memory fake',
  make: () => {
    const sender = createFakeWhatsAppSender();
    return Promise.resolve({ sender, sign: (raw) => sender.signBody(raw) });
  },
});

const request = {
  templateKey: 'appointment_reminder',
  to: '+5491155550001',
  vars: { firstName: 'Ana', date: '2031-01-02', time: '10:00' },
  idempotencyKey: 'reminder:appt-1:24h',
};

describe('fake WhatsApp sender', () => {
  it('accepts a message and records it with the provider id it gave', async () => {
    const sender = createFakeWhatsAppSender();

    const result = await sender.send(request);

    expect(result.status).toBe('accepted');
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({
      to: '+5491155550001',
      templateKey: 'appointment_reminder',
    });
    expect(result.status === 'accepted' && result.providerMessageId).toBe(
      sender.sent[0]?.providerMessageId,
    );
  });

  it('sends once per idempotency key, and gives the same id back', async () => {
    const sender = createFakeWhatsAppSender();

    const first = await sender.send(request);
    const again = await sender.send(request);
    const other = await sender.send({ ...request, idempotencyKey: 'reminder:appt-1:2h' });

    expect(again).toEqual(first);
    expect(other).not.toEqual(first);
    expect(sender.sent).toHaveLength(2);
  });

  it('verifies a webhook signed with the app secret and refuses any other', () => {
    const sender = createFakeWhatsAppSender({ appSecret: 'fake-app-secret-0123456789' });
    const body = JSON.stringify({ events: [] });

    const signature = sender.signBody(body);

    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(sender.verifyWebhook(body, { 'x-hub-signature-256': signature })).toBe(true);
    expect(sender.verifyWebhook(`${body} `, { 'x-hub-signature-256': signature })).toBe(false);
    expect(sender.verifyWebhook(body, { 'x-hub-signature-256': 'sha256=00' })).toBe(false);
    expect(sender.verifyWebhook(body, {})).toBe(false);
  });

  it('turns a webhook body into normalized events and drops what is not an event', () => {
    const sender = createFakeWhatsAppSender();

    const events = sender.parseEvents({
      events: [
        {
          kind: 'status',
          eventId: 'e1',
          providerMessageId: 'wamid.1',
          status: 'delivered',
          occurredAt: '2031-01-01T10:00:00.000Z',
        },
        {
          kind: 'inbound',
          eventId: 'e2',
          from: '+5491155550001',
          text: '1',
          occurredAt: '2031-01-01T10:05:00.000Z',
        },
        { kind: 'status', eventId: 'e3', status: 'exploded' },
        'garbage',
      ],
    });

    expect(events.map((event) => event.eventId)).toEqual(['e1', 'e2']);
    expect(events[0]).toMatchObject({ kind: 'status', status: 'delivered' });
    expect(events[1]).toMatchObject({ kind: 'inbound', text: '1' });
    expect(sender.parseEvents('not an object')).toEqual([]);
    expect(sender.parseEvents(null)).toEqual([]);
  });
});
