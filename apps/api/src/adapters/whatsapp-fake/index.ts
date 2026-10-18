import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import type {
  WebhookHeaders,
  WhatsAppEvent,
  WhatsAppSender,
  WhatsAppSendRequest,
  WhatsAppSendResult,
} from '../../modules/notifications/application/ports.js';

export interface FakeWhatsAppMessage extends WhatsAppSendRequest {
  providerMessageId: string;
}

export interface FakeWhatsAppSender extends WhatsAppSender {
  /** Every message accepted, oldest first. */
  readonly sent: readonly FakeWhatsAppMessage[];
  /** The `X-Hub-Signature-256` value for a body, as the provider would sign it. */
  signBody(rawBody: Buffer | string): string;
  clear(): void;
}

const DEFAULT_APP_SECRET = 'fake-whatsapp-app-secret';
/** The most messages the fake remembers (and the idempotency keys with them). */
export const FAKE_WHATSAPP_CAPACITY = 1_000;
const SIGNATURE_HEADER = 'x-hub-signature-256';

const EventBody = z.object({
  events: z.array(z.unknown()),
});
const StatusEvent = z.object({
  kind: z.literal('status'),
  eventId: z.string().min(1),
  providerMessageId: z.string().min(1),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  occurredAt: z.coerce.date(),
  errorCode: z.string().optional(),
});
const InboundEvent = z.object({
  kind: z.literal('inbound'),
  eventId: z.string().min(1),
  from: z.string().min(1),
  text: z.string(),
  occurredAt: z.coerce.date(),
  contextMessageId: z.string().min(1).optional(),
});

function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * In-memory WhatsApp sender for tests and for demo organizations (design section 6: the fake of the
 * `WhatsAppSender` port). It is deterministic: the provider id comes from the idempotency key, so a
 * test can predict it, and nothing leaves the process.
 */
export function createFakeWhatsAppSender(
  options: { appSecret?: string; capacity?: number } = {},
): FakeWhatsAppSender {
  const secret = options.appSecret ?? DEFAULT_APP_SECRET;
  const capacity = options.capacity ?? FAKE_WHATSAPP_CAPACITY;
  const byKey = new Map<string, FakeWhatsAppMessage>();

  const sign = (rawBody: Buffer | string) =>
    `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

  return {
    get sent() {
      return [...byKey.values()];
    },
    send(request): Promise<WhatsAppSendResult> {
      let message = byKey.get(request.idempotencyKey);
      if (!message) {
        const digest = createHash('sha256').update(request.idempotencyKey).digest('hex');
        message = { ...request, providerMessageId: `fake.${digest.slice(0, 24)}` };
        byKey.set(request.idempotencyKey, message);
        // The oldest goes first (a Map keeps the order of insertion): the fake serves demo
        // organizations in a process that stays up, and must not grow with every message.
        while (byKey.size > capacity) {
          const oldest = byKey.keys().next().value;
          if (oldest === undefined) break;
          byKey.delete(oldest);
        }
      }
      return Promise.resolve({ status: 'accepted', providerMessageId: message.providerMessageId });
    },
    signBody: sign,
    verifyWebhook(rawBody, headers) {
      const given = headerValue(headers, SIGNATURE_HEADER);
      if (given === undefined) return false;
      const expected = Buffer.from(sign(rawBody));
      const actual = Buffer.from(given);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
    parseEvents(body): readonly WhatsAppEvent[] {
      const parsed = EventBody.safeParse(body);
      if (!parsed.success) return [];
      return parsed.data.events.flatMap((candidate): WhatsAppEvent[] => {
        const status = StatusEvent.safeParse(candidate);
        if (status.success) {
          const { errorCode, ...rest } = status.data;
          return [errorCode === undefined ? rest : { ...rest, errorCode }];
        }
        const inbound = InboundEvent.safeParse(candidate);
        if (!inbound.success) return [];
        const { contextMessageId, ...rest } = inbound.data;
        return [contextMessageId === undefined ? rest : { ...rest, contextMessageId }];
      });
    },
    clear() {
      byKey.clear();
    },
  };
}
