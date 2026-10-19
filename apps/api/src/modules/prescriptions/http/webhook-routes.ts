import type { IncomingHttpHeaders } from 'node:http';

import { ErxWebhookEvent } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import { ERX_RECONCILE_JOB } from '../application/job-names.js';

/** What a provider adapter offers to check that a notice really came from the provider. */
export interface WebhookVerifier {
  verifyWebhook(raw: Buffer, headers: IncomingHttpHeaders): boolean;
}

/** An adapter that can verify the notices of its provider (the local simulator, the real one). */
export function asWebhookVerifier(adapter: unknown): WebhookVerifier | undefined {
  const candidate = adapter as { verifyWebhook?: unknown } | undefined;
  return typeof candidate?.verifyWebhook === 'function'
    ? (candidate as WebhookVerifier)
    : undefined;
}

/** A tenant id that matches no row: the transaction has a context but belongs to nobody. */
const NO_TENANT = '00000000-0000-0000-0000-000000000000';

export interface WebhookDeps {
  withTenant: WithTenant;
  /** The provider that signs the notices. Absent: there is no provider, no webhook. */
  verifier: WebhookVerifier | undefined;
  jobs: JobClient | undefined;
}

interface Found {
  tenantId: string;
  prescriptionId: string;
}

/**
 * Which organization holds the prescription a provider identifier names. The notice carries no
 * organization and the organization never comes from what it says: it comes from OUR record of the
 * identifier. A `SECURITY DEFINER` function (migration 0530) answers with ids and nothing else.
 */
async function prescriptionsOf(withTenant: WithTenant, externalId: string): Promise<Found[]> {
  return withTenant({ tenantId: NO_TENANT, userId: SYSTEM_USER_ID }, async (tx) => {
    const rows = await tx.execute<{ tenant_id: string; prescription_id: string }>(
      sql`select tenant_id, prescription_id from app.erx_prescription_by_external_id(${externalId}::text)`,
    );
    return rows.rows.map((row) => ({
      tenantId: row.tenant_id,
      prescriptionId: row.prescription_id,
    }));
  });
}

/**
 * `POST /webhooks/erx`: the notice of the provider that a prescription changed state (dispensed,
 * expired, cancelled on its side). Allowed in a read-only organization (a provider notice is not a
 * user action).
 *
 * - The signature is checked over the RAW body before anything else; an unsigned or wrongly signed
 *   request is refused and changes nothing.
 * - The notice is only a nudge: it queues a reconciliation of that prescription, and the state is
 *   whatever the provider says when asked. A forged or repeated notice therefore cannot set a state,
 *   and the same notice twice is harmless (a repeat inside a few seconds is queued once).
 * - A notice about an identifier we do not hold is acknowledged and dropped, with nothing in the
 *   answer that tells whether the identifier exists.
 */
export function webhookRoutes(deps: WebhookDeps) {
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
        '/webhooks/erx',
        { config: { auth: 'public', readOnly: 'webhook', audits: 'none' } },
        async (request, reply) => {
          const raw = request.body;
          if (!deps.verifier) return reply.code(404).send();
          if (!Buffer.isBuffer(raw) || !deps.verifier.verifyWebhook(raw, request.headers)) {
            throw new AppError('unauthenticated');
          }
          let body: unknown;
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            throw new AppError('bad_request');
          }
          const event = ErxWebhookEvent.safeParse(body);
          if (!event.success) throw new AppError('bad_request');

          const found = await prescriptionsOf(deps.withTenant, event.data.externalId);
          for (const { tenantId, prescriptionId } of found) {
            await deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
              await deps.jobs?.enqueue(
                tx,
                ERX_RECONCILE_JOB,
                { tenantId, prescriptionId },
                { singletonKey: prescriptionId, singletonSeconds: 5 },
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
