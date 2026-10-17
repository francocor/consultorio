import type { FastifyInstance } from 'fastify';

import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { MessagingDeps } from '../application/deps.js';
import { processInbound, type InboundDeps } from '../application/inbound.js';
import {
  tenantsByProviderMessageId,
  tenantsByRecipientHash,
  tenantsByReplyContext,
} from '../application/lookup.js';
import type { WhatsAppEvent, WhatsAppSender } from '../application/ports.js';
import { applyStatusEvent } from '../application/status-events.js';
import { hashAddress } from '../domain/address.js';
import { classifyReply } from '../domain/keywords.js';
import { normalizeInboundNumber } from '../domain/phone.js';

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
 * - A reply names no organization, and one number can be on the books of several. It is attributed
 *   to ONE: the organization of the message it quotes (when it quotes one that went to that number),
 *   else the one that wrote to the number within the last week. When several did, "1" and "2" go
 *   to every candidate as a reply to read, and only BAJA acts, in each of them, naming each one.
 * - It answers in a read-only organization too (it is a webhook, not a user action); what a reply
 *   may do there is decided by `processInbound`.
 */

/** A reply is about the organizations that wrote to the number within this many days. */
const REPLY_WINDOW_DAYS = 7;
/** More organizations than this writing to one number in a week is not a case worth serving. */
const MAX_CANDIDATES = 5;

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
            const from = normalizeInboundNumber(event.from);
            if (from === null) {
              // Nobody can be found from text that is not a number. A BAJA must not vanish without a trace.
              if (classifyReply(event.text) === 'opt_out') {
                request.log.warn(
                  { eventId: event.eventId },
                  'opt-out from a sender that is not a number',
                );
              }
              continue;
            }
            const attribution = await attribute(deps, event, from);
            for (const tenantId of attribution.tenantIds) {
              const outcome = await deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) =>
                processInbound(deps.inbound, tx, event, {
                  from,
                  ambiguous: attribution.tenantIds.length > 1,
                  ...(attribution.quoted ? { quotedMessageId: attribution.quoted } : {}),
                }),
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

interface Attribution {
  /** The organizations the reply is about, the one that wrote last first. */
  tenantIds: string[];
  /** The provider id of the quoted message, when the quote is what attributed the reply. */
  quoted: string | null;
}

async function attribute(
  deps: WhatsAppWebhookDeps,
  event: Extract<WhatsAppEvent, { kind: 'inbound' }>,
  from: string,
): Promise<Attribution> {
  const hash = hashAddress('whatsapp', from);
  if (event.contextMessageId !== undefined) {
    const quoted = await tenantsByReplyContext(deps.withTenant, event.contextMessageId, hash);
    if (quoted.length === 1) return { tenantIds: quoted, quoted: event.contextMessageId };
  }
  const since = new Date(deps.inbound.clock().getTime() - REPLY_WINDOW_DAYS * 86_400_000);
  const recent = await tenantsByRecipientHash(deps.withTenant, hash, {
    since,
    limit: MAX_CANDIDATES,
  });
  if (recent.length > 0 || classifyReply(event.text) !== 'opt_out') {
    return { tenantIds: recent, quoted: null };
  }
  // Nobody wrote lately and the patient wants out: the last organization that wrote hears it.
  return {
    tenantIds: await tenantsByRecipientHash(deps.withTenant, hash, { since: null, limit: 1 }),
    quoted: null,
  };
}
