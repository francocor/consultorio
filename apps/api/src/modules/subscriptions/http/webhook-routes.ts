import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { subscriptionEvent } from '../../../db/schema/subscriptions.js';
import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import { SUBSCRIPTION_RECONCILE_JOB } from '../application/job-names.js';
import type { PaymentsGateway, WebhookNotice } from '../application/ports.js';
import { callWithin } from '../application/provider.js';

/** A tenant id that matches no row: the transaction has a context but belongs to nobody. */
const NO_TENANT = '00000000-0000-0000-0000-000000000000';

export interface SubscriptionWebhookDeps {
  withTenant: WithTenant;
  /** The gateway that signs the notices; absent: there is no provider, no webhook. */
  gateway: () => PaymentsGateway | undefined;
  jobs: JobClient | undefined;
  clock: () => Date;
  providerTimeoutMs?: number | undefined;
}

interface Found {
  tenantId: string;
}

/**
 * Which organizations hold what a notice names. The notice carries no organization, and the
 * organization never comes from what it says: it comes from OUR records of the preapproval, the
 * payment or the reference. A `SECURITY DEFINER` function (migration 0614) answers with ids and
 * nothing else.
 */
async function lookup(
  withTenant: WithTenant,
  keys: { preapprovalId: string | null; paymentId: string | null; reference: string | null },
): Promise<Found[]> {
  return withTenant({ tenantId: NO_TENANT, userId: SYSTEM_USER_ID }, async (tx) => {
    const rows = await tx.execute<{ tenant_id: string }>(
      sql`select tenant_id from app.subscription_for_notice(
            ${keys.preapprovalId}::text, ${keys.paymentId}::text, ${keys.reference}::text)`,
    );
    return [...new Set(rows.rows.map((row) => row.tenant_id))].map((tenantId) => ({ tenantId }));
  });
}

/** When nothing known matches the resource, the provider is asked what it is (a bounded read). */
async function resolveByProvider(
  deps: SubscriptionWebhookDeps,
  gateway: PaymentsGateway,
  notice: WebhookNotice,
): Promise<Found[] | 'unavailable'> {
  if (notice.topic === 'preapproval') {
    const answer = await callWithin(
      deps,
      (signal) => gateway.getPreapproval(notice.resourceId, signal),
      undefined,
    );
    const lookupResult = answer.value;
    if (lookupResult === undefined || lookupResult.status === 'retryable') return 'unavailable';
    if (lookupResult.status === 'unknown') return [];
    return lookup(deps.withTenant, {
      preapprovalId: lookupResult.preapproval.preapprovalId,
      paymentId: null,
      reference: lookupResult.preapproval.externalReference,
    });
  }
  const answer = await callWithin(
    deps,
    (signal) => gateway.getPayment(notice.resourceId, signal),
    undefined,
  );
  const payment = answer.value;
  if (payment === undefined || payment.status === 'retryable') return 'unavailable';
  if (payment.status === 'unknown') return [];
  return lookup(deps.withTenant, {
    preapprovalId: payment.payment.preapprovalId ?? null,
    paymentId: payment.payment.paymentId,
    reference: payment.payment.externalReference,
  });
}

/**
 * `POST /webhooks/mercadopago`: the notice of the payments provider that a preapproval or a payment
 * changed. Allowed in a read-only organization (a provider notice is not a user action, and paying is
 * how it recovers).
 *
 * - The signature is checked over the RAW body, with its time window, before anything else. A forged,
 *   altered, unsigned or stale notice is refused with one generic answer and changes nothing.
 * - The notice is only a nudge: it records its event id (UNIQUE, so a repeat finds its row and does
 *   nothing) and queues a reconcile of the subscription. The state is whatever the provider answers
 *   when that job asks, so a duplicate, an old or an out-of-order notice cannot set a state.
 * - A notice about something no subscription holds is acknowledged and dropped, with nothing in the
 *   answer that tells whether the resource exists, and nothing about any organization.
 */
export function subscriptionWebhookRoutes(deps: SubscriptionWebhookDeps) {
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
        '/webhooks/mercadopago',
        {
          config: {
            auth: 'public',
            readOnly: 'webhook',
            audits: 'none',
            // A provider sends a notice per change; a client that sends more than this in a minute is
            // not one (and a captured notice cannot be replayed in bulk).
            rateLimit: { max: 240, timeWindow: 60_000 },
          },
        },
        async (request, reply) => {
          const gateway = deps.gateway();
          if (!gateway) return reply.code(404).send();
          const raw = request.body;
          if (!Buffer.isBuffer(raw)) throw new AppError('unauthenticated');
          const verified = gateway.verifyWebhook(raw, request.headers, { now: deps.clock() });
          if (!verified.valid) {
            // One line per refusal and nothing of the notice: a wrong secret, a clock out of step, a
            // forgery and a replay all look alike from outside.
            request.log.warn('a notice of the payments provider was refused: not authentic');
            throw new AppError('unauthenticated');
          }
          const { notice } = verified;

          let found = await lookup(deps.withTenant, {
            preapprovalId: notice.topic === 'preapproval' ? notice.resourceId : null,
            paymentId: notice.topic === 'preapproval' ? null : notice.resourceId,
            reference: null,
          });
          if (found.length === 0) {
            const resolved = await resolveByProvider(deps, gateway, notice);
            // The provider cannot say what this is: let it send the notice again.
            if (resolved === 'unavailable') throw new AppError('service_unavailable');
            found = resolved;
          }

          for (const { tenantId } of found) {
            await deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
              const recorded = await tx
                .insert(subscriptionEvent)
                .values({
                  tenantId,
                  eventId: notice.eventId,
                  topic: notice.topic,
                  resourceId: notice.resourceId,
                  signedAt: notice.signedAt,
                })
                .onConflictDoNothing({ target: subscriptionEvent.eventId })
                .returning({ id: subscriptionEvent.id });
              // A delivery that was recorded before changes nothing: no second job, no second effect.
              if (recorded.length === 0) return;
              await deps.jobs?.enqueue(
                tx,
                SUBSCRIPTION_RECONCILE_JOB,
                { tenantId },
                { singletonKey: tenantId, singletonSeconds: 1 },
              );
            });
          }
          return reply.code(200).send({ accepted: true });
        },
      );
      done();
    });
  };
}
