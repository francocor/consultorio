import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WEBHOOK_TOLERANCE_MS,
  deliveryKeyOf,
  manifestFor,
  signWebhook,
  verifyMercadoPagoWebhook,
} from './mp-signature.js';

const secret = 'placeholder-mp-webhook-secret-0123';
const now = new Date('2026-10-20T15:00:00.000Z');
const body = JSON.stringify({
  id: 987654,
  type: 'payment',
  action: 'payment.created',
  data: { id: '55501234' },
});

function signedAt(offsetMs: number, overrides: { body?: string; secret?: string } = {}) {
  return signWebhook({
    secret: overrides.secret ?? secret,
    body: overrides.body ?? body,
    requestId: 'req-0001',
    ts: now.getTime() + offsetMs,
  });
}

describe('the manifest Mercado Pago signs', () => {
  it('is the id, the request id and the time, in that order, each ending with a semicolon', () => {
    expect(manifestFor({ id: '55501234', requestId: 'req-0001', ts: 1760972400000 })).toBe(
      'id:55501234;request-id:req-0001;ts:1760972400000;',
    );
  });

  it('lowercases an alphanumeric id, as the provider documents, and leaves other ids alone', () => {
    expect(manifestFor({ id: 'ABC123', requestId: 'r', ts: 1 })).toBe(
      'id:abc123;request-id:r;ts:1;',
    );
    expect(manifestFor({ id: 'AB-12', requestId: 'r', ts: 1 })).toBe('id:AB-12;request-id:r;ts:1;');
  });
});

describe('verifyMercadoPagoWebhook', () => {
  it('accepts a notice signed with the secret and says only what to ask about', () => {
    const request = signedAt(0);

    const result = verifyMercadoPagoWebhook({ secret, ...request, now });

    expect(result).toEqual({
      valid: true,
      notice: {
        eventId: deliveryKeyOf({ id: '55501234', requestId: 'req-0001', ts: now.getTime() }),
        topic: 'payment',
        resourceId: '55501234',
        signedAt: now,
      },
    });
  });

  it('keys a delivery by what the provider signed, never by the unsigned id of the body (JD-S6 R1, S6-9)', () => {
    const request = signedAt(0);
    const verify = (rawBody: string, headers: Record<string, string>) => {
      const result = verifyMercadoPagoWebhook({ secret, rawBody, headers, now });
      if (!result.valid) throw new Error(`refused: ${result.reason}`);
      return result.notice.eventId;
    };

    const original = verify(request.rawBody, request.headers);

    // The same signed request delivered twice is the same delivery.
    expect(verify(request.rawBody, request.headers)).toBe(original);
    // A captured request replayed with another body id (the signature does not cover it) is the SAME
    // delivery, so it cannot occupy the key of a delivery that has not arrived yet.
    expect(verify(request.rawBody.replace('987654', '111'), request.headers)).toBe(original);
    // Another request id, another time or another resource is another delivery.
    const other = signWebhook({ secret, body, requestId: 'req-0002', ts: now.getTime() });
    expect(verify(other.rawBody, other.headers)).not.toBe(original);
    const later = signWebhook({ secret, body, requestId: 'req-0001', ts: now.getTime() + 1 });
    expect(verify(later.rawBody, later.headers)).not.toBe(original);
    const elsewhere = signWebhook({
      secret,
      body: body.replace('55501234', '55501235'),
      requestId: 'req-0001',
      ts: now.getTime(),
    });
    expect(verify(elsewhere.rawBody, elsewhere.headers)).not.toBe(original);
  });

  it('maps the topics of the provider to the ones of the port', () => {
    const topics = [
      ['subscription_preapproval', 'preapproval'],
      ['subscription_authorized_payment', 'authorized_payment'],
      ['payment', 'payment'],
    ] as const;
    for (const [type, topic] of topics) {
      const payload = JSON.stringify({ id: 1, type, data: { id: 'pre-9' } });
      const result = verifyMercadoPagoWebhook({ secret, ...signedAt(0, { body: payload }), now });

      expect(result, type).toMatchObject({ valid: true, notice: { topic, resourceId: 'pre-9' } });
    }
  });

  it('never puts a status in the notice, whatever the body claims', () => {
    const payload = JSON.stringify({
      id: 5,
      type: 'payment',
      status: 'approved',
      data: { id: '77', status: 'approved' },
    });

    const result = verifyMercadoPagoWebhook({ secret, ...signedAt(0, { body: payload }), now });

    expect(result.valid).toBe(true);
    expect(Object.keys(result.valid ? result.notice : {}).sort()).toEqual([
      'eventId',
      'resourceId',
      'signedAt',
      'topic',
    ]);
  });

  it('refuses a request with no signature header', () => {
    const { rawBody, headers } = signedAt(0);
    const withoutSignature = { 'x-request-id': headers['x-request-id'] };

    expect(verifyMercadoPagoWebhook({ secret, rawBody, headers: withoutSignature, now })).toEqual({
      valid: false,
      reason: 'missing_signature',
    });
    expect(
      verifyMercadoPagoWebhook({ secret, rawBody, headers: { 'x-signature': 'garbage' }, now }),
    ).toEqual({ valid: false, reason: 'missing_signature' });
  });

  it('refuses a body that was altered after it was signed', () => {
    const { headers } = signedAt(0);
    const altered = body.replace('55501234', '55509999');

    expect(verifyMercadoPagoWebhook({ secret, rawBody: altered, headers, now })).toEqual({
      valid: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a notice signed with another secret', () => {
    const forged = signedAt(0, { secret: 'placeholder-another-secret-0123' });

    expect(verifyMercadoPagoWebhook({ secret, ...forged, now })).toEqual({
      valid: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a request id that was swapped, since it is part of what is signed', () => {
    const { rawBody, headers } = signedAt(0);

    expect(
      verifyMercadoPagoWebhook({
        secret,
        rawBody,
        headers: { ...headers, 'x-request-id': 'req-9999' },
        now,
      }),
    ).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('refuses a notice captured earlier or dated ahead, even though its signature is right', () => {
    const tolerance = DEFAULT_WEBHOOK_TOLERANCE_MS;

    expect(verifyMercadoPagoWebhook({ secret, ...signedAt(-(tolerance + 1)), now })).toEqual({
      valid: false,
      reason: 'stale',
    });
    expect(verifyMercadoPagoWebhook({ secret, ...signedAt(tolerance + 1), now })).toEqual({
      valid: false,
      reason: 'stale',
    });
    // The edges of the window are inside it.
    expect(verifyMercadoPagoWebhook({ secret, ...signedAt(-tolerance), now }).valid).toBe(true);
    expect(verifyMercadoPagoWebhook({ secret, ...signedAt(tolerance), now }).valid).toBe(true);
  });

  it('honours a window the caller narrows', () => {
    const result = verifyMercadoPagoWebhook({
      secret,
      ...signedAt(-10_000),
      now,
      toleranceMs: 5_000,
    });

    expect(result).toEqual({ valid: false, reason: 'stale' });
  });

  it('says a correctly signed body that is not a notice of a known topic is malformed', () => {
    for (const payload of [
      'not json',
      JSON.stringify({ id: 1, type: 'chargebacks', data: { id: '1' } }),
      JSON.stringify({ id: 1, type: 'payment' }),
      JSON.stringify({ type: 'payment', data: { id: '1' } }),
    ]) {
      const result = verifyMercadoPagoWebhook({ secret, ...signedAt(0, { body: payload }), now });

      expect(result, payload).toEqual({ valid: false, reason: 'malformed' });
    }
  });

  it('reads the body as bytes just the same as as text', () => {
    const request = signedAt(0);

    const result = verifyMercadoPagoWebhook({
      secret,
      rawBody: new TextEncoder().encode(request.rawBody),
      headers: request.headers,
      now,
    });

    expect(result.valid).toBe(true);
  });
});
