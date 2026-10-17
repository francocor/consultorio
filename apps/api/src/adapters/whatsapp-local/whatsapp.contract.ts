import { describe, expect, it } from 'vitest';

import type { WhatsAppSender } from '../../modules/notifications/application/ports.js';

/**
 * The contract of the `WhatsAppSender` port (design section 6, "one shared suite per port"). The
 * in-memory fake, the local simulator and, later, the Meta Cloud API adapter must all pass it:
 * what the notifications module relies on is written here once.
 */

export interface WhatsAppContractTarget {
  name: string;
  /** A fresh sender with its own state, and the way the provider signs a webhook body for it. */
  make(): Promise<{ sender: WhatsAppSender; sign: (rawBody: string) => string }>;
}

const REQUEST = {
  templateKey: 'appointment_reminder',
  to: '+5491144445555',
  vars: {
    name: 'María',
    organization: 'Centro Médico',
    date: 'lunes 12 de mayo',
    time: '10:00',
    place: 'Sede Centro',
  },
} as const;

let counter = 0;
const key = () => `contract-${String(Date.now())}-${String((counter += 1))}`;

export function describeWhatsAppContract(target: WhatsAppContractTarget): void {
  describe(`WhatsAppSender contract: ${target.name}`, () => {
    it('accepts an approved template for a valid number and answers with a provider id', async () => {
      const { sender } = await target.make();

      const result = await sender.send({ ...REQUEST, idempotencyKey: key() });

      expect(result.status).toBe('accepted');
      expect(result.status === 'accepted' && result.providerMessageId.length > 0).toBe(true);
    });

    it('sends once for one idempotency key: the second call returns the same provider id', async () => {
      const { sender } = await target.make();
      const idempotencyKey = key();

      const first = await sender.send({ ...REQUEST, idempotencyKey });
      const second = await sender.send({ ...REQUEST, idempotencyKey });

      expect(first).toEqual(second);
      expect(first.status).toBe('accepted');
    });

    it('gives each idempotency key its own provider id', async () => {
      const { sender } = await target.make();

      const first = await sender.send({ ...REQUEST, idempotencyKey: key() });
      const second = await sender.send({ ...REQUEST, idempotencyKey: key() });

      expect(first.status === 'accepted' && second.status === 'accepted').toBe(true);
      expect(first).not.toEqual(second);
    });

    it('accepts a webhook body that carries the provider signature of that body', async () => {
      const { sender, sign } = await target.make();
      const raw = JSON.stringify({ events: [] });

      expect(sender.verifyWebhook(raw, { 'x-hub-signature-256': sign(raw) })).toBe(true);
      expect(sender.verifyWebhook(Buffer.from(raw), { 'x-hub-signature-256': sign(raw) })).toBe(
        true,
      );
    });

    it('rejects a body that was changed, a missing signature and a signature of another body', async () => {
      const { sender, sign } = await target.make();
      const raw = JSON.stringify({ events: [] });
      const signature = sign(raw);

      expect(sender.verifyWebhook(`${raw} `, { 'x-hub-signature-256': signature })).toBe(false);
      expect(sender.verifyWebhook(raw, {})).toBe(false);
      expect(sender.verifyWebhook(raw, { 'x-hub-signature-256': sign('other') })).toBe(false);
      expect(sender.verifyWebhook(raw, { 'x-hub-signature-256': 'sha256=' })).toBe(false);
      expect(sender.verifyWebhook(raw, { 'x-hub-signature-256': 'garbage' })).toBe(false);
    });

    it('normalizes the status and inbound events of a body, and drops everything else', async () => {
      const { sender } = await target.make();
      const occurredAt = '2031-05-12T13:00:00.000Z';

      const events = sender.parseEvents({
        events: [
          {
            kind: 'status',
            eventId: 'evt-1',
            providerMessageId: 'wamid.1',
            status: 'delivered',
            occurredAt,
          },
          { kind: 'inbound', eventId: 'evt-2', from: '+5491144445555', text: '1', occurredAt },
          { kind: 'status', eventId: 'evt-3' },
          { kind: 'something else' },
          'noise',
        ],
      });

      expect(events).toEqual([
        {
          kind: 'status',
          eventId: 'evt-1',
          providerMessageId: 'wamid.1',
          status: 'delivered',
          occurredAt: new Date(occurredAt),
        },
        {
          kind: 'inbound',
          eventId: 'evt-2',
          from: '+5491144445555',
          text: '1',
          occurredAt: new Date(occurredAt),
        },
      ]);
    });

    it('never throws on a body that is not an event list', async () => {
      const { sender } = await target.make();

      for (const body of [undefined, null, 'text', 42, [], {}, { events: 'x' }]) {
        expect(sender.parseEvents(body)).toEqual([]);
      }
    });
  });
}
