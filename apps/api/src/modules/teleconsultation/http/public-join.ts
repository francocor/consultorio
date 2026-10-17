import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import { openPublicJoin, type PublicJoinOutcome } from '../application/public-join.js';
import type { SessionDeps } from '../application/video-sessions.js';
import { readBrand } from '../application/video-state.js';
import { describeInstant } from '../domain/local-time.js';

import { renderJoinPage, type JoinPageModel } from './join-page.js';

export interface PublicJoinDeps {
  withTenant: WithTenant;
  tokens: ActionTokens;
  adapters: SessionDeps['adapters'];
  clock: () => Date;
}

/** At most this many opens per client and minute (a patient opens the link a few times). */
const OPENS_PER_MINUTE = 30;

const STATUS: Record<Exclude<PublicJoinOutcome['kind'], 'redirect'>, number> = {
  early: 200,
  pending: 200,
  closed: 410,
  unavailable: 404,
};

/**
 * `GET /public/v/:token`, the address a patient receives for a virtual appointment (design 4.5).
 * It is public by design and protected by the token alone: inside the join window it records that
 * the link was opened and forwards (302) to the call; anywhere else it answers a short page in
 * es-AR. The tenant comes from the host, never from the token, so another organization's token
 * finds nothing. The route is limited per client, and the response is never cached and never
 * leaks the address (no referrer).
 */
export function publicJoinRoutes(deps: PublicJoinDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/public/v/:token',
      {
        config: {
          readOnly: 'read',
          auth: 'public',
          rateLimit: { max: OPENS_PER_MINUTE, timeWindow: 60_000 },
          audits: ['video.link.opened'],
        },
        schema: { params: z.strictObject({ token: z.string().min(1).max(512) }) },
      },
      async (request, reply) => {
        const context = request.hostContext;
        if (context?.kind !== 'tenant') throw new AppError('not_found');

        const { outcome, brand } = await deps.withTenant(
          { tenantId: context.tenant.id, userId: SYSTEM_USER_ID },
          async (tx) => ({
            outcome: await openPublicJoin(tx, deps, {
              token: request.params.token,
              actor: request.auditActor,
            }),
            brand: await readBrand(tx),
          }),
        );

        if (outcome.kind === 'redirect') return reply.redirect(outcome.url, 302);

        const model: JoinPageModel = {
          kind: outcome.kind,
          organization: brand.organization,
          accent: brand.accent,
          ...(outcome.kind === 'early'
            ? { opensAt: describeInstant(outcome.opensAt, outcome.timeZone) }
            : {}),
        };
        const page = renderJoinPage(model);
        return reply
          .code(STATUS[outcome.kind])
          .header('content-type', 'text/html; charset=utf-8')
          .header('content-security-policy', page.contentSecurityPolicy)
          .header('x-robots-tag', 'noindex, nofollow')
          .send(page.html);
      },
    );
  };
}
