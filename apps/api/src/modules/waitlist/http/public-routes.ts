import {
  PublicResendRequest,
  PublicWaitlistConfirmRequest,
  PublicWaitlistJoinedResponse,
  PublicWaitlistJoinRequest,
  PublicWaitlistJoinResponse,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AdapterResolver } from '../../../main/adapter-resolver.js';
import type { BotChallenge } from '../../../platform/bot-challenge/bot-challenge.js';
import { SYSTEM_USER_ID, type Tx, type WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError, denied } from '../../../platform/http/problem.js';
import type { ResolvedTenant } from '../../../platform/http/tenant-host.js';
import {
  confirmJoin,
  resendJoinCode,
  submitJoin,
  type JoinDeps,
  type SubmitOutcome,
} from '../application/join.js';

export interface PublicRoutesDeps {
  withTenant: WithTenant;
  adapters: AdapterResolver | undefined;
  clock: () => Date;
  join: JoinDeps;
}

const SlugParam = z.string().min(1).max(64);
const SlugParams = z.strictObject({ slug: SlugParam });
const IdParams = z.strictObject({ slug: SlugParam, id: z.uuid() });

/**
 * The public routes of the waitlist (design 4.5): no session, the organization from the host and
 * the professional from the booking link, a bot challenge before anything is stored, and a code by
 * email before anything is created. Every address that is not live, for whatever reason (never
 * existed, disabled, a professional or a type the link does not expose, a read-only organization),
 * answers the same generic 404.
 */
export function publicRoutes(deps: PublicRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    function tenantOf(request: FastifyRequest): ResolvedTenant {
      const context = request.hostContext;
      if (context?.kind !== 'tenant') throw new AppError('not_found');
      return context.tenant;
    }

    const run = <T>(tenant: ResolvedTenant, work: (tx: Tx) => Promise<T>) =>
      deps.withTenant({ tenantId: tenant.id, userId: SYSTEM_USER_ID }, work);

    const joinTenant = (tenant: ResolvedTenant) => ({
      id: tenant.id,
      country: tenant.country,
      slug: tenant.slug,
      isDemo: tenant.isDemo,
    });

    /** The bot challenge of this organization, or a closed form when none is configured. */
    function challengeOf(tenant: ResolvedTenant): BotChallenge {
      const challenge = deps.adapters?.forTenant(
        { id: tenant.id, isDemo: tenant.isDemo },
        'botChallenge',
      );
      if (!challenge) throw new AppError('service_unavailable');
      return challenge;
    }

    /** The bot challenge comes first: nothing else is spent on a request that fails it. */
    async function solved(
      request: FastifyRequest,
      reply: FastifyReply,
      tenant: ResolvedTenant,
      proof: string,
    ): Promise<void> {
      void reply.header('cache-control', 'no-store');
      if (!(await challengeOf(tenant).verify(proof, request.ip))) {
        throw new AppError('booking_challenge_failed');
      }
    }

    function answerFor(
      outcome: SubmitOutcome,
      request: FastifyRequest,
      reply: FastifyReply,
    ): FastifyReply | PublicWaitlistJoinResponse {
      if (outcome.ok) {
        return {
          id: outcome.id,
          maskedEmail: outcome.maskedEmail,
          codeExpiresAt: outcome.codeExpiresAt.toISOString(),
        };
      }
      if (outcome.refusal === 'rate_limited') throw new AppError('rate_limited');
      return denied(request, reply);
    }

    typed.post(
      '/public/:slug/waitlist',
      {
        config: {
          readOnly: 'write',
          auth: 'public',
          audits: ['booking.suspicious'],
          rateLimit: { max: 20, timeWindow: 60_000 },
        },
        schema: {
          params: SlugParams,
          body: PublicWaitlistJoinRequest,
          response: { 200: PublicWaitlistJoinResponse },
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        const { challengeProof, ...form } = request.body;
        await solved(request, reply, tenant, challengeProof);
        const outcome = await run(tenant, (tx) =>
          submitJoin(tx, deps.join, {
            tenant: joinTenant(tenant),
            organizationSlug: request.params.slug,
            form,
            ip: request.ip,
            actor: request.auditActor,
            now: deps.clock(),
          }),
        );
        return answerFor(outcome, request, reply);
      },
    );

    typed.post(
      '/public/:slug/waitlist/:id/code',
      {
        config: {
          readOnly: 'write',
          auth: 'public',
          audits: 'none',
          rateLimit: { max: 10, timeWindow: 60_000 },
        },
        schema: {
          params: IdParams,
          body: PublicResendRequest,
          response: { 200: PublicWaitlistJoinResponse },
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        await solved(request, reply, tenant, request.body.challengeProof);
        const outcome = await run(tenant, (tx) =>
          resendJoinCode(tx, deps.join, {
            tenant: joinTenant(tenant),
            submissionId: request.params.id,
            ip: request.ip,
            actor: request.auditActor,
            now: deps.clock(),
          }),
        );
        return answerFor(outcome, request, reply);
      },
    );

    typed.post(
      '/public/:slug/waitlist/:id/confirm',
      {
        config: {
          readOnly: 'write',
          auth: 'public',
          // The entry (and the patient, when the visitor was nobody's yet) are audited by the use
          // case: it needs the ids it just made.
          audits: ['waitlist.entry.created', 'patient.created', 'patient.consent.recorded'],
          rateLimit: { max: 20, timeWindow: 60_000 },
        },
        schema: {
          params: IdParams,
          body: PublicWaitlistConfirmRequest,
          response: { 200: PublicWaitlistJoinedResponse },
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        void reply.header('cache-control', 'no-store');
        const outcome = await run(tenant, (tx) =>
          confirmJoin(tx, deps.join, {
            tenant: joinTenant(tenant),
            organizationSlug: request.params.slug,
            submissionId: request.params.id,
            code: request.body.code,
            actor: request.auditActor,
            now: deps.clock(),
          }),
        );
        if (outcome.ok) {
          const optIn = outcome.whatsappOptIn;
          const port = deps.join.whatsappOptIn;
          // After the answer: the link goes to the address the visitor verified, and a failure to
          // send is logged, never shown to them (they are on the list either way).
          if (optIn && port) {
            request.server.background.run(() =>
              port.send({ tenant: joinTenant(tenant), ...optIn }),
            );
          }
          return { joined: true as const, expiresAt: outcome.expiresAt.toISOString() };
        }
        if (outcome.refusal === 'invalid_code') throw new AppError('waitlist_code_invalid');
        return denied(request, reply);
      },
    );
  };
}
