import {
  PortalAcceptedResponse,
  PortalCodeRequest,
  PortalCodeVerifyRequest,
  PortalRegisterRequest,
  PortalRegisterVerifyRequest,
  PortalSignedInResponse,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AdapterResolver } from '../../../main/adapter-resolver.js';
import type { BotChallenge } from '../../../platform/bot-challenge/bot-challenge.js';
import { SYSTEM_USER_ID, type Tx, type WithTenant } from '../../../platform/db/tenant-context.js';
import { serializePortalCookie } from '../../../platform/http/portal-session.js';
import { AppError } from '../../../platform/http/problem.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { ResolvedTenant } from '../../../platform/http/tenant-host.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import {
  requestRegistrationCode,
  requestSignInCode,
  verifyRegistrationCode,
  verifySignInCode,
  type SignInContext,
  type SignInDeps,
  type VerifyOutcome,
} from '../application/sign-in.js';
import { PORTAL_SESSION_ABSOLUTE_MS } from '../domain/session-rules.js';

export interface PublicRoutesDeps {
  withTenant: WithTenant;
  adapters: AdapterResolver | undefined;
  origins: PublicOrigins;
  signIn: SignInDeps;
}

const UNKNOWN_CLIENT_WARNING_EVERY_MS = 60_000;

const SlugParams = z.strictObject({ slug: z.string().min(1).max(64) });

/** What the four routes audit, for the policy that every mutating route says what it writes. */
const AUDITS = [
  'portal.identity.created',
  'portal.identity.linked',
  'portal.signin.success',
  'portal.signin.failure',
] as const;

/**
 * The public routes of the portal (`/public/:slug/portal/*`, design 4.5): register with the
 * document and the email on the record, ask for a code, and use it. They are the only way into the
 * portal and they tell a stranger nothing:
 *
 * - Asking for a code (registering or signing in) always answers the same body, whether or not
 *   anything was sent. The code goes only to the address on the record or of the account.
 * - A wrong code, an expired one, none at all and an unknown address answer the same 400.
 * - The bot challenge comes first, then the per-address counters; the routes also carry a limit per
 *   client.
 * - The organization is the host's. The `:slug` of the path is never read, and nothing else in
 *   the path, the query or the body can name another organization.
 * - They are `auth` routes for the read-only policy: signing in stays open in a read-only
 *   organization.
 */
export function publicRoutes(deps: PublicRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    /** When each organization last got the warning about a client with no known address. */
    const unknownClientWarnedAt = new Map<string, number>();

    function tenantOf(request: FastifyRequest<{ Params: { slug: string } }>): ResolvedTenant {
      const context = request.hostContext;
      // The organization is the host's. The `:slug` of the path is there for the shape of the
      // public prefix (design 4.5) and is never read: nothing in the path can name an organization.
      if (context?.kind !== 'tenant') throw new AppError('not_found');
      return context.tenant;
    }

    const run = <T>(tenant: ResolvedTenant, work: (tx: Tx) => Promise<T>) =>
      deps.withTenant({ tenantId: tenant.id, userId: SYSTEM_USER_ID }, work);

    function challengeOf(tenant: ResolvedTenant): BotChallenge {
      const challenge = deps.adapters?.forTenant(
        { id: tenant.id, isDemo: tenant.isDemo },
        'botChallenge',
      );
      if (!challenge) throw new AppError('service_unavailable');
      return challenge;
    }

    function jobsOf(): JobClient {
      if (!deps.signIn.jobs) throw new AppError('service_unavailable');
      return deps.signIn.jobs;
    }

    function contextOf(request: FastifyRequest, tenant: ResolvedTenant): SignInContext {
      // A client whose address is unknown is counted by its user agent, which is NOT a security
      // boundary (a client changes it at will; JD-S5 R4-7). It means `TRUST_PROXY` does not match the
      // proxies in front of the app, so it is said (no address, no user agent in the line), once a
      // minute per organization: a flood of such requests must not flood the log (JD-S5 R5).
      if (request.auditActor.ip === null) {
        const now = Date.now();
        const last = unknownClientWarnedAt.get(tenant.id);
        if (last === undefined || now - last >= UNKNOWN_CLIENT_WARNING_EVERY_MS) {
          unknownClientWarnedAt.set(tenant.id, now);
          request.log.warn(
            { tenantId: tenant.id, route: request.routeOptions.url },
            'the client address of a portal request is unknown',
          );
        }
      }
      return {
        tenant: { id: tenant.id, country: tenant.country },
        actor: request.auditActor,
        ip: request.auditActor.ip,
        userAgent: request.auditActor.userAgent,
      };
    }

    async function assertHuman(
      tenant: ResolvedTenant,
      proof: string,
      request: FastifyRequest,
    ): Promise<void> {
      if (!(await challengeOf(tenant).verify(proof, request.ip))) {
        throw new AppError('portal_challenge_failed');
      }
    }

    /** Starts the session of a successful verification, or answers the one error that exists. */
    function answerVerification(
      outcome: VerifyOutcome,
      tenant: ResolvedTenant,
      reply: FastifyReply,
    ): { signedIn: true } {
      if (outcome.outcome === 'locked') throw new AppError('rate_limited');
      if (outcome.outcome === 'invalid') throw new AppError('portal_code_invalid');
      void reply.header(
        'set-cookie',
        serializePortalCookie(outcome.token, {
          secure: deps.origins(tenant.slug).startsWith('https:'),
          maxAgeSeconds: PORTAL_SESSION_ABSOLUTE_MS / 1000,
        }),
      );
      return { signedIn: true };
    }

    const config = (max: number) =>
      ({
        readOnly: 'auth',
        auth: 'public',
        audits: AUDITS,
        rateLimit: { max, timeWindow: 60_000 },
      }) as const;

    typed.post(
      '/public/:slug/portal/register',
      {
        config: config(10),
        schema: {
          params: SlugParams,
          body: PortalRegisterRequest,
          response: { 200: PortalAcceptedResponse },
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        void reply.header('cache-control', 'no-store');
        await assertHuman(tenant, request.body.challengeProof, request);
        const jobs = jobsOf();
        await run(tenant, (tx) =>
          requestRegistrationCode(tx, { ...deps.signIn, jobs }, contextOf(request, tenant), {
            nationalId: request.body.nationalId,
            email: request.body.email,
          }),
        );
        return { accepted: true } as const;
      },
    );

    typed.post(
      '/public/:slug/portal/register/verify',
      {
        config: config(20),
        schema: {
          params: SlugParams,
          body: PortalRegisterVerifyRequest,
          response: { 200: PortalSignedInResponse },
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        void reply.header('cache-control', 'no-store');
        // The transaction commits what the try recorded (attempts, the trail) before the answer
        // turns into an error.
        const outcome = await run(tenant, (tx) =>
          verifyRegistrationCode(tx, deps.signIn, contextOf(request, tenant), {
            nationalId: request.body.nationalId,
            email: request.body.email,
            code: request.body.code,
          }),
        );
        return answerVerification(outcome, tenant, reply);
      },
    );

    typed.post(
      '/public/:slug/portal/otp',
      {
        config: config(10),
        schema: {
          params: SlugParams,
          body: PortalCodeRequest,
          response: { 200: PortalAcceptedResponse },
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        void reply.header('cache-control', 'no-store');
        await assertHuman(tenant, request.body.challengeProof, request);
        const jobs = jobsOf();
        await run(tenant, (tx) =>
          requestSignInCode(tx, { ...deps.signIn, jobs }, contextOf(request, tenant), {
            email: request.body.email,
          }),
        );
        return { accepted: true } as const;
      },
    );

    typed.post(
      '/public/:slug/portal/otp/verify',
      {
        config: config(20),
        schema: {
          params: SlugParams,
          body: PortalCodeVerifyRequest,
          response: { 200: PortalSignedInResponse },
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        void reply.header('cache-control', 'no-store');
        const outcome = await run(tenant, (tx) =>
          verifySignInCode(tx, deps.signIn, contextOf(request, tenant), {
            email: request.body.email,
            code: request.body.code,
          }),
        );
        return answerVerification(outcome, tenant, reply);
      },
    );
  };
}
