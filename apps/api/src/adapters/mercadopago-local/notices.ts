import { randomUUID } from 'node:crypto';

import type { PaymentsSimulatorMode } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';

import type { LocalPaymentsGateway } from './index.js';

/**
 * The notices the local Mercado Pago sends to the application's own webhook (`POST
 * /webhooks/mercadopago`). A notice names a resource and nothing else, the way the provider's does:
 * `{ id, type, action, data: { id } }`. It is signed with the manifest of Mercado Pago and posted to
 * the real route, so the path of the provider (signature, window, event id, queued reconciliation)
 * is the path of the simulation.
 */

export type NoticeType = 'payment' | 'subscription_preapproval' | 'subscription_authorized_payment';

export interface Notice {
  /** The id of this delivery: the key the webhook records, so a repeated delivery changes nothing. */
  eventId: string;
  type: NoticeType;
  /** The preapproval or the payment to ask about. */
  resourceId: string;
}

/** A notice that the state of a preapproval changed. */
export function preapprovalNotice(preapprovalId: string): Notice {
  return { eventId: randomUUID(), type: 'subscription_preapproval', resourceId: preapprovalId };
}

/**
 * The notices of a payment: one when it is created and one when its state is final, as the provider
 * sends them. Both point at the same payment, so the application asks the provider for its state
 * and an old notice delivered after a new one cannot make the payment regress.
 */
export function paymentNotices(paymentId: string): Notice[] {
  return [
    { eventId: randomUUID(), type: 'payment', resourceId: paymentId },
    { eventId: randomUUID(), type: 'payment', resourceId: paymentId },
  ];
}

/** The body of a notice, as Mercado Pago writes it. */
export function bodyOf(notice: Notice): string {
  return JSON.stringify({
    id: notice.eventId,
    type: notice.type,
    action: 'updated',
    data: { id: notice.resourceId },
  });
}

/**
 * How the notices reach the webhook in each mode: `duplicate_events` delivers each one twice (the
 * same event id, as a provider that does not know whether its first delivery arrived), and
 * `out_of_order` delivers them backwards (an older notice after a newer one).
 */
export function deliveryPlan(notices: readonly Notice[], mode: PaymentsSimulatorMode): Notice[] {
  const ordered = mode === 'out_of_order' ? [...notices].reverse() : [...notices];
  return mode === 'duplicate_events' ? ordered.flatMap((notice) => [notice, notice]) : ordered;
}

/** The same signed request, posted as it is (a repeated delivery is the same bytes and the same headers). */
interface Signed {
  rawBody: string;
  headers: Record<string, string>;
}

/** Posts a signed notice to the webhook of the application; true when the webhook accepted it. */
async function post(server: Pick<FastifyInstance, 'inject'>, signed: Signed): Promise<boolean> {
  const response = await server.inject({
    method: 'POST',
    url: '/webhooks/mercadopago',
    headers: { 'content-type': 'application/json', ...signed.headers },
    payload: signed.rawBody,
  });
  return response.statusCode === 200;
}

/**
 * Delivers notices in the order the mode says; returns how many the webhook accepted. A notice is
 * signed once however many times it is delivered: the key of a delivery is what the provider signed
 * (the request id, the resource and the time), so a repeated delivery is the same request again.
 */
export async function deliver(
  server: Pick<FastifyInstance, 'inject'>,
  gateway: Pick<LocalPaymentsGateway, 'sign'>,
  mode: PaymentsSimulatorMode,
  notices: readonly Notice[],
): Promise<number> {
  const signed = new Map<Notice, Signed>();
  let accepted = 0;
  for (const notice of deliveryPlan(notices, mode)) {
    const request = signed.get(notice) ?? gateway.sign(bodyOf(notice));
    signed.set(notice, request);
    if (await post(server, request)) accepted += 1;
  }
  return accepted;
}
