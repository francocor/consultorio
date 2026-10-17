import type { FastifyInstance } from 'fastify';

import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { MessagingDeps } from '../application/deps.js';
import { processInbound, type InboundDeps } from '../application/inbound.js';
import { tenantsByProviderMessageId, tenantsByRecipientHash } from '../application/lookup.js';
import type { WhatsAppSender } from '../application/ports.js';
import { applyStatusEvent } from '../application/status-events.js';
import { hashAddress } from '../domain/address.js';
import { normalizeWhatsAppNumber } from '../domain/phone.js';

/**
 * `POST /webhooks/whatsapp`: delivery receipts and replies from the WhatsApp provider (spec
 * "Provider webhooks and inbound messages"; design 4.5).
 *
 * - The signature (`X-Hub-Signature-256`, HMAC-SHA256 of the RAW body) is checked before anything
 *   else, over the bytes as they arrived; an unsigned or wrongly signed request is refused and
 *   changes nothing.
 * - The organization of an event is never in the request: it is found from our record of the
 *   message the event is about, or of the number a reply came from.
 * - A replayed event is applied once (the id of the provider's event is unique).
 * - Events about messages we never sent, and replies from numbers we never wrote to, are dropped:
 *   no record, no patient, no appointment.
 * - It answers in a read-only organization too (it is a webhook, not a user action); what a reply
 *   may do there is decided by `processInbound`.
 */

export interface WhatsAppWebhookDeps {
  withTenant: WithTenant;
  /** The provider that signs the webhook. Absent: there is no WhatsApp provider, no webhook. */
  sender: WhatsAppSender | undefined;
  /** What replies need (acknowledgments, the worklist, the appointment events). */
  inbound: InboundDeps;
  /** What a failure after acceptance needs (the other channel, reception). */
  reactions: MessagingDeps | undefined;
}

export function whatsappWebhookRoutes(deps: WhatsAppWebhookDeps) {
  return (app: FastifyInstance): void => {
    // A child scope, so the raw-body parser applies to this route only and not to the rest of the module.
    void app.register((scope, _options, done) => {
      scope.removeContentTypeParser('application/json');
      scope.addContentTypeParser(
        'application/json',
        { parseAs: 'buffer' },
        (_request, body, next) => {
          next(null, body);
        },
      );

      scope.post(
        '/webhooks/whatsapp',
        {
          config: {
            auth: 'public',
            readOnly: 'webhook',
            audits: [
              'notification.optout.recorded',
              'appointment.status_changed',
              'appointment.cancelled',
            ],
          },
        },
        async (request, reply) => {
          const sender = deps.sender;
          const raw = request.body;
          if (!sender) return reply.code(404).send();
          if (!Buffer.isBuffer(raw) || !sender.verifyWebhook(raw, request.headers)) {
            throw new AppError('unauthenticated');
          }

          let body: unknown;
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            throw new AppError('bad_request');
          }

          let applied = 0;
          for (const event of sender.parseEvents(body)) {
            if (event.kind === 'status') {
              for (const tenantId of await tenantsByProviderMessageId(
                deps.withTenant,
                event.providerMessageId,
              )) {
                const outcome = await deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) =>
                  applyStatusEvent(tx, event, deps.reactions),
                );
                if (outcome === 'applied') applied += 1;
              }
              continue;
            }
            const from = normalizeWhatsAppNumber(event.from);
            if (from === null) continue;
            const tenantIds = await tenantsByRecipientHash(
              deps.withTenant,
              hashAddress('whatsapp', from),
            );
            for (const tenantId of tenantIds) {
              const outcome = await deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) =>
                processInbound(deps.inbound, tx, event, { from }),
              );
              if (outcome !== 'duplicate') applied += 1;
            }
          }
          return reply.code(200).send({ processed: applied });
        },
      );
      done();
    });
  };
}
