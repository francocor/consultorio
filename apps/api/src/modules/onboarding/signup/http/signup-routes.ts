import {
  PublicChallengeResponse,
  SignupAcceptedResponse,
  SignupRenewRequest,
  SignupRequest,
  SignupResendRequest,
  SignupVerifiedResponse,
  SignupVerifyRequest,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { AdapterResolver } from '../../../../main/adapter-resolver.js';
import type { BotChallenge } from '../../../../platform/bot-challenge/bot-challenge.js';
import { AppError } from '../../../../platform/http/problem.js';
import { serializeSessionCookie } from '../../../../platform/http/session-cookie.js';
import type { ResolvedTenant } from '../../../../platform/http/tenant-host.js';
import { SESSION_ABSOLUTE_MS } from '../../../identity/index.js';
import type { SignupService } from '../application/service.js';

export interface SignupRoutesDeps {
  service: SignupService;
  /** Resolves the bot challenge of the form (`forTenant(PLATFORM, 'botChallenge')`). */
  adapters: AdapterResolver | undefined;
  cookieSecure: boolean;
}

/** The platform has no organization of its own: the resolver is asked about the nil one, not a demo. */
const PLATFORM = { id: '00000000-0000-0000-0000-000000000000', isDemo: false } as const;

/**
 * The public routes of the signup (tenant-onboarding, Part B). They are the only unauthenticated
 * onboarding entry points (identity-access). They exist in multi mode only (the composition root
 * registers them behind the `signup` feature) and each one lives on one kind of host:
 *
 * - the form and the request for a new link by address, on the PLATFORM host: there is no
 *   organization yet, so no branding and no session;
 * - the link itself, and the request for a new one from its page, on the host of the UNVERIFIED
 *   organization: that host is the only thing that names it (a body never selects an organization),
 *   and the session the verification starts is a cookie of that very host.
 *
 * What they answer never depends on whether a name or an address was already in use: the work done
 * before the answer is the same (see `application/service.ts`), and the email goes out after it.
 * Nothing here logs a name, an address, a password or a token.
 */
export function signupRoutes(deps: SignupRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    function challenge(): BotChallenge {
      const found = deps.adapters?.forTenant(PLATFORM, 'botChallenge');
      if (!found) throw new AppError('service_unavailable');
      return found;
    }

    async function assertHuman(proof: string, request: FastifyRequest): Promise<void> {
      if (!(await challenge().verify(proof, request.ip))) {
        throw new AppError('signup_challenge_failed');
      }
    }

    /** The host is the platform's: where the form and the request by address live. */
    function onPlatformHost(request: FastifyRequest): void {
      if (request.hostContext?.kind !== 'platform') throw new AppError('not_found');
    }

    /** The host is an organization nobody confirmed yet, the only kind this route serves. */
    function unverifiedTenant(request: FastifyRequest): ResolvedTenant {
      const context = request.hostContext;
      if (context?.kind !== 'tenant' || context.tenant.status !== 'unverified') {
        throw new AppError('not_found');
      }
      return context.tenant;
    }

    /** Public, no session, its own bucket of requests per client. */
    const config = (max: number) =>
      ({ auth: 'public', rateLimit: { max, timeWindow: 60_000 } }) as const;

    typed.get(
      '/public/signup/challenge',
      {
        config: { ...config(30), readOnly: 'read', unverifiedAllowed: true },
        schema: { response: { 200: PublicChallengeResponse } },
      },
      async (request, reply) => {
        const context = request.hostContext;
        const served =
          context?.kind === 'platform' ||
          (context?.kind === 'tenant' && context.tenant.status === 'unverified');
        if (!served) throw new AppError('not_found');
        void reply.header('cache-control', 'no-store');
        return challenge().issue(request.ip);
      },
    );

    typed.post(
      '/public/signup',
      {
        config: { ...config(10), readOnly: 'auth', audits: ['signup.created', 'terms.accepted'] },
        schema: { body: SignupRequest, response: { 200: SignupAcceptedResponse } },
      },
      async (request, reply) => {
        onPlatformHost(request);
        void reply.header('cache-control', 'no-store');
        // Refusing the terms costs the visitor nothing: it is checked before the challenge is spent.
        if (!request.body.acceptTerms || !request.body.acceptDataProcessing) {
          throw new AppError('signup_terms_required');
        }
        await assertHuman(request.body.challengeProof, request);
        const delivery = await deps.service.signUp(request.body, { actor: request.auditActor });
        // After the answer: how long the email takes must not tell whether the address had an account.
        request.server.background.run(delivery);
        return { accepted: true } as const;
      },
    );

    typed.post(
      '/public/signup/resend',
      {
        config: { ...config(10), readOnly: 'auth', audits: 'none' },
        schema: { body: SignupResendRequest, response: { 200: SignupAcceptedResponse } },
      },
      async (request, reply) => {
        onPlatformHost(request);
        void reply.header('cache-control', 'no-store');
        await assertHuman(request.body.challengeProof, request);
        const delivery = await deps.service.resend(request.body.email, {
          actor: request.auditActor,
        });
        request.server.background.run(delivery);
        return { accepted: true } as const;
      },
    );

    typed.post(
      '/public/signup/renew',
      {
        config: { ...config(10), readOnly: 'auth', audits: 'none', unverifiedAllowed: true },
        schema: { body: SignupRenewRequest, response: { 200: SignupAcceptedResponse } },
      },
      async (request, reply) => {
        const tenant = unverifiedTenant(request);
        void reply.header('cache-control', 'no-store');
        await assertHuman(request.body.challengeProof, request);
        const delivery = await deps.service.renew(tenant.id, { actor: request.auditActor });
        request.server.background.run(delivery);
        return { accepted: true } as const;
      },
    );

    typed.post(
      '/public/signup/verify',
      {
        config: {
          ...config(20),
          readOnly: 'auth',
          audits: ['signup.verified'],
          unverifiedAllowed: true,
        },
        schema: { body: SignupVerifyRequest, response: { 200: SignupVerifiedResponse } },
      },
      async (request, reply) => {
        const context = request.hostContext;
        // An organization that is already active answers like a link that does not work.
        if (context?.kind !== 'tenant') throw new AppError('not_found');
        void reply.header('cache-control', 'no-store');
        const issued = await deps.service.verify(context.tenant, request.body.token, {
          actor: request.auditActor,
        });
        void reply.header(
          'set-cookie',
          serializeSessionCookie(issued.token, {
            secure: deps.cookieSecure,
            maxAgeSeconds: SESSION_ABSOLUTE_MS / 1000,
          }),
        );
        return { verified: true } as const;
      },
    );
  };
}
