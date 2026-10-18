import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
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
  keys: TenantKeys;
  tokens: ActionTokens;
  adapters: SessionDeps['adapters'];
  clock: () => Date;
}

/** At most this many opens per client and minute (a patient opens the link a few times). */
const OPENS_PER_MINUTE = 30;

const STATUS: Record<Exclude<PublicJoinOutcome['kind'], 'redirect'>, number> = {
  ready: 200,
  early: 200,
  pending: 200,
  closed: 410,
  unavailable: 404,
};

/**
 * `GET|POST /public/v/:token`, the address a patient receives for a virtual appointment (design
 * 4.5). It is public by design and protected by the token alone. Like every emailed link, a GET only
 * LOOKS (a mail scanner or a preview opens links, and must not spend a use of it nor make the
 * session look opened): inside the join window it shows the notice about the third-party video
 * service and a button; anywhere else it answers a short page in es-AR. The button POSTs to the same
 * address (the platform checks the request comes from the same origin), and only then is the use
 * spent, the opening recorded and the patient forwarded (302) to the call. The tenant comes from the
 * host, never from the token, so another organization's token finds nothing. The route is limited
 * per client, and the response is never cached.
 */
export function publicJoinRoutes(deps: PublicJoinDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    const Params = z.strictObject({ token: z.string().min(1).max(512) });

    async function respond(
      request: FastifyRequest<{ Params: { token: string } }>,
      reply: FastifyReply,
      mode: 'view' | 'enter',
    ): Promise<FastifyReply> {
      const context = request.hostContext;
      if (context?.kind !== 'tenant') throw new AppError('not_found');

      const { outcome, brand } = await deps.withTenant(
        { tenantId: context.tenant.id, userId: SYSTEM_USER_ID },
        async (tx) => ({
          outcome: await openPublicJoin(tx, deps, {
            mode,
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
      void reply
        .code(STATUS[outcome.kind])
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-security-policy', page.contentSecurityPolicy)
        .header('x-robots-tag', 'noindex, nofollow');
      // The button posts back to this address: with `no-referrer` the browser would send
      // `Origin: null`, which the origin check refuses. The address never leaves its own origin.
      if (page.hasForm) void reply.header('referrer-policy', 'same-origin');
      return reply.send(page.html);
    }

    typed.get(
      '/public/v/:token',
      {
        config: {
          readOnly: 'read',
          auth: 'public',
          rateLimit: { max: OPENS_PER_MINUTE, timeWindow: 60_000 },
          audits: 'none',
        },
        schema: { params: Params },
      },
      (request, reply) => respond(request, reply, 'view'),
    );

    typed.post(
      '/public/v/:token',
      {
        config: {
          // Whether the organization is read-only is decided inside, as for a disabled link.
          readOnly: 'patient_protective',
          auth: 'public',
          rateLimit: { max: OPENS_PER_MINUTE, timeWindow: 60_000 },
          audits: ['video.link.opened'],
        },
        schema: { params: Params },
      },
      (request, reply) => respond(request, reply, 'enter'),
    );
  };
}
