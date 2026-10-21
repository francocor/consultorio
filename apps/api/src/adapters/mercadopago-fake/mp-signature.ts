import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type {
  WebhookHeaders,
  WebhookTopic,
  WebhookVerification,
} from '../../modules/subscriptions/application/ports.js';

/**
 * The webhook signature of Mercado Pago, as a pure function, shared by the fake, the local
 * simulator and (later) the real gateway so all of them check a notice the same way. The provider
 * signs a manifest `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` with HMAC-SHA256 and the shared
 * secret, and sends `x-signature: ts=<ts>,v1=<hex>` next to `x-request-id`. The time is part of what
 * is signed, so a notice captured on the wire cannot be replayed once it is outside the window.
 */

export const SIGNATURE_HEADER = 'x-signature';
export const REQUEST_ID_HEADER = 'x-request-id';

/** Five minutes either way, like the e-prescription webhook. */
export const DEFAULT_WEBHOOK_TOLERANCE_MS = 5 * 60_000;

/** The names of the topics in the body of a notice, mapped to the ones of the port. */
const TOPIC_OF_TYPE: Readonly<Record<string, WebhookTopic>> = {
  payment: 'payment',
  subscription_preapproval: 'preapproval',
  subscription_authorized_payment: 'authorized_payment',
};

export interface ManifestParts {
  /** The id of the resource the notice is about (`data.id`). */
  id: string;
  requestId: string;
  /** Milliseconds since the epoch, as the provider writes it. */
  ts: number;
}

/** The text that is signed. The provider documents lowercasing an id made of letters and digits. */
export function manifestFor({ id, requestId, ts }: ManifestParts): string {
  const normalized = /^[A-Za-z0-9]+$/.test(id) ? id.toLowerCase() : id;
  return `id:${normalized};request-id:${requestId};ts:${String(ts)};`;
}

/**
 * The key of idempotence of a delivery: derived ONLY from what the provider signed (the request id,
 * the resource and the time), never from the `id` of the body, which the signature does not cover. A
 * captured notice that is replayed with another body id would otherwise be recorded as a delivery
 * that never happened, and the real one, arriving later with that id, would be dropped as a repeat
 * (JD-S6 R1, S6-9). The same signed request delivered twice has the same key.
 */
export function deliveryKeyOf(parts: ManifestParts): string {
  return createHash('sha256').update(manifestFor(parts)).digest('hex');
}

function hmacHex(secret: string, text: string): string {
  return createHmac('sha256', secret).update(text).digest('hex');
}

function bodyText(rawBody: string | Uint8Array): string {
  return typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody);
}

function firstHeader(headers: WebhookHeaders, name: string): string | undefined {
  const value = headers[name];
  const first = typeof value === 'string' ? value : value?.[0];
  return typeof first === 'string' && first !== '' ? first : undefined;
}

interface Reading {
  /** The `id` of the body: NOT signed, so it is only checked to be there, never used as a key. */
  eventId: string;
  type: string;
  /** What the manifest is signed over: the id the body names, or empty when it names none. */
  resourceId: string;
}

/** What the body of a notice says; every part is empty when the body does not say it. */
function readBody(text: string): Reading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { eventId: '', type: '', resourceId: '' };
  }
  if (typeof parsed !== 'object' || parsed === null)
    return { eventId: '', type: '', resourceId: '' };
  const { id, type, data } = parsed as { id?: unknown; type?: unknown; data?: unknown };
  const resource =
    typeof data === 'object' && data !== null ? (data as { id?: unknown }).id : undefined;
  const scalar = (value: unknown) =>
    typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  return {
    eventId: scalar(id),
    type: typeof type === 'string' ? type : '',
    resourceId: scalar(resource),
  };
}

/** Parses `ts=<ms>,v1=<hex>`. */
function readSignature(header: string): { ts: number; v1: string } | null {
  const parts = Object.fromEntries(
    header.split(',').map((part) => {
      const index = part.indexOf('=');
      return index < 0
        ? [part.trim(), '']
        : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
    }),
  ) as Record<string, string>;
  const ts = Number(parts['ts']);
  const v1 = parts['v1'];
  if (!Number.isSafeInteger(ts) || ts <= 0 || v1 === undefined || !/^[0-9a-f]{64}$/.test(v1)) {
    return null;
  }
  return { ts, v1 };
}

export interface VerifyInput {
  secret: string;
  rawBody: string | Uint8Array;
  headers: WebhookHeaders;
  now?: Date;
  toleranceMs?: number;
}

/**
 * Checks, in this order: the signature header exists, the HMAC over the manifest matches, the signed
 * time is inside the window, and only then that the body is a notice of a known topic. A notice that fails the signature is never
 * told apart from "stale" by timing or by order: staleness is reported only for a notice whose
 * signature is right, which is the one an attacker cannot make.
 */
export function verifyMercadoPagoWebhook(input: VerifyInput): WebhookVerification {
  const header = firstHeader(input.headers, SIGNATURE_HEADER);
  const signature = header === undefined ? null : readSignature(header);
  const requestId = firstHeader(input.headers, REQUEST_ID_HEADER);
  if (signature === null || requestId === undefined) {
    return { valid: false, reason: 'missing_signature' };
  }

  const reading = readBody(bodyText(input.rawBody));
  const expected = hmacHex(
    input.secret,
    manifestFor({ id: reading.resourceId, requestId, ts: signature.ts }),
  );
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature.v1))) {
    return { valid: false, reason: 'bad_signature' };
  }

  const now = (input.now ?? new Date()).getTime();
  const tolerance = input.toleranceMs ?? DEFAULT_WEBHOOK_TOLERANCE_MS;
  if (Math.abs(now - signature.ts) > tolerance) return { valid: false, reason: 'stale' };

  // Only a notice that is really the provider's gets told it is unreadable.
  const topic = TOPIC_OF_TYPE[reading.type];
  if (topic === undefined || reading.eventId === '' || reading.resourceId === '') {
    return { valid: false, reason: 'malformed' };
  }
  return {
    valid: true,
    notice: {
      eventId: deliveryKeyOf({
        id: reading.resourceId,
        requestId,
        ts: signature.ts,
      }),
      topic,
      resourceId: reading.resourceId,
      signedAt: new Date(signature.ts),
    },
  };
}

export interface SignInput {
  secret: string;
  body: string;
  requestId: string;
  ts: number;
}

/**
 * What the provider sends for a body: the raw body and the headers. The local simulator uses it to
 * call the webhook of the application, and the tests to forge or replay one. The manifest uses the
 * id of the resource the body names, like the provider does.
 */
export function signWebhook(input: SignInput): {
  rawBody: string;
  headers: Record<string, string>;
} {
  const v1 = hmacHex(
    input.secret,
    manifestFor({ id: readBody(input.body).resourceId, requestId: input.requestId, ts: input.ts }),
  );
  return {
    rawBody: input.body,
    headers: {
      [SIGNATURE_HEADER]: `ts=${String(input.ts)},v1=${v1}`,
      [REQUEST_ID_HEADER]: input.requestId,
    },
  };
}
