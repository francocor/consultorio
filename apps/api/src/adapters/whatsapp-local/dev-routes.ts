import { randomUUID } from 'node:crypto';

import {
  SimulatorEventResponse,
  SimulatorInboundRequest,
  SimulatorModeRequest,
  SimulatorStateResponse,
  SimulatorStatusRequest,
  SimulatorUnreachableRequest,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { AppError } from '../../platform/http/problem.js';

import type { LocalWhatsAppControls, LocalWhatsAppSender } from './index.js';

/**
 * The controls of the local WhatsApp simulator (`/operator/dev/whatsapp/*`, developer console).
 * They exist only while `LOCAL_PROVIDERS_CONSOLE=true` and live inside the operator console, so
 * they answer only on the platform host behind the operator session.
 *
 * Every event the simulator produces (a delivery receipt, a reply) is SIGNED here with the app
 * secret and POSTED to the application's own webhook, so the path a real provider takes
 * (signature check, tenant lookup, idempotence) is the path the simulation takes.
 */

const MESSAGES_SHOWN = 100;
const MessageParams = z.strictObject({ providerMessageId: z.string().min(1).max(128) });

export interface WhatsAppDevRoutesDeps {
  controls: LocalWhatsAppControls;
  sender: LocalWhatsAppSender;
}

export function whatsappDevRoutes(deps: WhatsAppDevRoutesDeps) {
  const { controls, sender } = deps;

  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    const base = '/operator/dev/whatsapp';
    const read = { readOnly: 'read', auth: 'public', operatorAuth: 'session' } as const;
    const write = {
      readOnly: 'write',
      auth: 'public',
      operatorAuth: 'session',
      audits: 'none',
    } as const;

    /** Signs an event and posts it to the real webhook; true when the webhook accepted it. */
    async function post(server: FastifyInstance, event: Record<string, unknown>): Promise<boolean> {
      const raw = JSON.stringify({ events: [event] });
      const response = await server.inject({
        method: 'POST',
        url: '/webhooks/whatsapp',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sender.signBody(raw),
        },
        payload: raw,
      });
      return response.statusCode === 200;
    }

    typed.get(
      `${base}/messages`,
      { config: read, schema: { response: { 200: SimulatorStateResponse } } },
      async () => ({
        messages: (await controls.messages(MESSAGES_SHOWN)).map((message) => ({
          ...message,
          createdAt: message.createdAt.toISOString(),
        })),
        mode: await controls.mode(),
        unreachableNumbers: await controls.unreachableNumbers(),
      }),
    );

    typed.post(
      `${base}/messages/:providerMessageId/status`,
      {
        config: write,
        schema: {
          params: MessageParams,
          body: SimulatorStatusRequest,
          response: { 200: SimulatorEventResponse },
        },
      },
      async (request) => {
        const { providerMessageId } = request.params;
        const known = (await controls.messages(MESSAGES_SHOWN)).some(
          (message) =>
            message.providerMessageId === providerMessageId && message.direction === 'outbound',
        );
        if (!known) throw new AppError('not_found');
        const delivered = await post(request.server, {
          kind: 'status',
          eventId: randomUUID(),
          providerMessageId,
          status: request.body.status,
          occurredAt: new Date().toISOString(),
          ...(request.body.errorCode === undefined ? {} : { errorCode: request.body.errorCode }),
        });
        if (delivered) {
          await controls.setStatus(providerMessageId, request.body.status, request.body.errorCode);
        }
        return { delivered };
      },
    );

    typed.post(
      `${base}/inbound`,
      {
        config: write,
        schema: { body: SimulatorInboundRequest, response: { 200: SimulatorEventResponse } },
      },
      async (request) => {
        const reply = await controls.recordInbound(request.body);
        const delivered = await post(request.server, {
          kind: 'inbound',
          eventId: reply.eventId,
          from: request.body.from,
          text: request.body.text,
          occurredAt: new Date().toISOString(),
        });
        return { delivered };
      },
    );

    typed.put(
      `${base}/mode`,
      {
        config: write,
        schema: { body: SimulatorModeRequest, response: { 200: SimulatorModeRequest } },
      },
      async (request) => {
        await controls.setMode(request.body.mode);
        return { mode: request.body.mode };
      },
    );

    typed.put(
      `${base}/unreachable`,
      {
        config: write,
        schema: {
          body: SimulatorUnreachableRequest,
          response: { 200: SimulatorUnreachableRequest },
        },
      },
      async (request) => {
        await controls.setUnreachable(request.body.number, request.body.unreachable);
        return request.body;
      },
    );
  };
}
