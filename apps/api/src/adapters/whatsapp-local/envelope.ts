import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import type {
  WebhookHeaders,
  WhatsAppEvent,
} from '../../modules/notifications/application/ports.js';

/**
 * The webhook envelope of the WhatsApp adapters that this project owns (the in-memory fake and the
 * local simulator): `{ "events": [...] }` with status and inbound events already in the shape the
 * notifications module understands, signed like Meta signs its webhooks (`X-Hub-Signature-256`,
 * HMAC-SHA256 of the raw body with the app secret). The Meta adapter maps Meta's own payload to
 * the same events and verifies the same header.
 */

const SIGNATURE_HEADER = 'x-hub-signature-256';

const Envelope = z.object({ events: z.array(z.unknown()) });
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
});

export function signBody(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** True only when the signature header matches the raw body, compared in constant time. */
export function verifySignature(
  secret: string,
  rawBody: Buffer | string,
  headers: WebhookHeaders,
): boolean {
  const given = headerValue(headers, SIGNATURE_HEADER);
  if (given === undefined) return false;
  const expected = Buffer.from(signBody(secret, rawBody));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The events of a body. Anything that is not a well-formed event is dropped, never thrown. */
export function parseEnvelope(body: unknown): readonly WhatsAppEvent[] {
  const parsed = Envelope.safeParse(body);
  if (!parsed.success) return [];
  return parsed.data.events.flatMap((candidate): WhatsAppEvent[] => {
    const status = StatusEvent.safeParse(candidate);
    if (status.success) {
      const { errorCode, ...rest } = status.data;
      return [errorCode === undefined ? rest : { ...rest, errorCode }];
    }
    const inbound = InboundEvent.safeParse(candidate);
    return inbound.success ? [inbound.data] : [];
  });
}
