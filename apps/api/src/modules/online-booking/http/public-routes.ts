import {
  PublicAvailabilityQuery,
  PublicAvailabilityResponse,
  PublicBookingPageDto,
  PublicChallengeResponse,
  PublicHoldDto,
  PublicHoldRequest,
  PublicResendRequest,
  PublicSubmissionRequest,
  PublicSubmissionResponse,
  type OnlineBookingSettings,
  type PublicBookingPageDto as PublicBookingPage,
  type PublicSlotDto,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AdapterResolver } from '../../../main/adapter-resolver.js';
import type { BotChallenge } from '../../../platform/bot-challenge/bot-challenge.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import { SYSTEM_USER_ID, type Tx, type WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError, conflictCode, denied } from '../../../platform/http/problem.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { ResolvedTenant } from '../../../platform/http/tenant-host.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import { SlotNoLongerAvailableError, SlotTakenError } from '../../scheduling/index.js';
import type { SchedulingPorts } from '../../scheduling/index.js';
import { readOrganizationName } from '../../tenancy/index.js';
import type { Abuse } from '../application/abuse.js';
import type { AvailabilityCache } from '../application/availability-cache.js';
import { readBookingSettings, type BookingSettings } from '../application/booking-settings.js';
import { publicAvailability } from '../application/public-availability.js';
import { createPublicHold, sourceKeyOf } from '../application/public-holds.js';
import {
  findOrganizationLink,
  findProfessionalOffer,
  listOrganizationOffers,
  type OfferContext,
  type ProfessionalOffer,
} from '../application/public-offer.js';
import {
  resendCode,
  submitBooking,
  type SubmissionDeps,
  type SubmitOutcome,
} from '../application/submissions.js';

import {
  newBookingSessionId,
  readBookingSession,
  serializeBookingSession,
} from './booking-session.js';

export interface PublicRoutesDeps {
  withTenant: WithTenant;
  origins: PublicOrigins;
  adapters: AdapterResolver | undefined;
  clock: () => Date;
  portsOf: (tx: Tx) => SchedulingPorts;
  availabilityCache: AvailabilityCache<PublicAvailabilityResponse>;
  keys: TenantKeys;
  /** Queues the email with the code. Absent: the form cannot be submitted (503). */
  jobs: JobClient | undefined;
  abuse: Abuse;
}

/** How long the anonymous booking session cookie lives: the length of a booking attempt, with room. */
const SESSION_SECONDS = 24 * 3600;

const SlugParam = z.string().min(1).max(64);
const PageParams = z.strictObject({ slug: SlugParam });
const ProfessionalParams = z.strictObject({ slug: SlugParam, professionalSlug: SlugParam });

const NEXT_SLOTS = 5;

/**
 * The public booking routes (design 4.5): no session, the organization from the host and the
 * professional from the link, no patient data in any answer. Every address that is not live, for
 * whatever reason (never existed, disabled, regenerated, read-only organization), answers the same
 * generic 404, so the answer reveals nothing about the organization.
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

    function offerContext(tenant: ResolvedTenant, settings: BookingSettings): OfferContext {
      return {
        now: deps.clock(),
        videoAvailable:
          settings.videoEnabled &&
          deps.adapters?.forTenant({ id: tenant.id, isDemo: tenant.isDemo }, 'videoLink') !==
            undefined,
        horizonDays: settings.booking.horizonDays,
        portsOf: deps.portsOf,
      };
    }

    /** The bot challenge of this organization, or a closed form when none is configured. */
    function challengeOf(tenant: ResolvedTenant): BotChallenge {
      const challenge = deps.adapters?.forTenant(
        { id: tenant.id, isDemo: tenant.isDemo },
        'botChallenge',
      );
      if (!challenge) throw new AppError('service_unavailable');
      return challenge;
    }

    const secureCookies = (tenant: ResolvedTenant) =>
      deps.origins(tenant.slug).startsWith('https:');

    function pageOf(
      scope: PublicBookingPage['scope'],
      organizationName: string,
      settings: BookingSettings,
      offers: readonly ProfessionalOffer[],
    ): PublicBookingPage {
      return {
        organizationName,
        scope,
        professionals: offers.map((offer) => ({
          slug: offer.link.slug,
          name: offer.name,
          specialties: offer.specialties,
          types: offer.types.map(({ id, name, durationMinutes, mode }) => ({
            id,
            name,
            durationMinutes,
            mode,
          })),
          locations: offer.locations,
        })),
        requiresApproval:
          settings.booking.requireApproval ||
          offers.some((o) => o.types.some((t) => t.requiresApproval)),
        horizonDays: settings.booking.horizonDays,
      };
    }

    // The challenge a page solves before it holds a slot or submits the form.
    typed.get(
      '/public/challenge',
      {
        config: {
          readOnly: 'read',
          auth: 'public',
          rateLimit: { max: 60, timeWindow: 60_000 },
        },
        schema: { response: { 200: PublicChallengeResponse } },
      },
      async (request, reply) => {
        void reply.header('cache-control', 'no-store');
        return challengeOf(tenantOf(request)).issue();
      },
    );

    typed.get(
      '/public/:slug/booking',
      {
        config: {
          readOnly: 'read',
          auth: 'public',
          rateLimit: { max: 120, timeWindow: 60_000 },
        },
        schema: { params: PageParams, response: { 200: PublicBookingPageDto } },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        const page = await run(tenant, async (tx) => {
          if (!(await findOrganizationLink(tx, request.params.slug))) return null;
          const settings = await readBookingSettings(tx);
          const offers = await listOrganizationOffers(tx, offerContext(tenant, settings));
          return pageOf('organization', await readOrganizationName(tx), settings, offers);
        });
        return page ?? denied(request, reply);
      },
    );

    typed.get(
      '/public/:slug/p/:professionalSlug',
      {
        config: {
          readOnly: 'read',
          auth: 'public',
          rateLimit: { max: 120, timeWindow: 60_000 },
        },
        schema: { params: ProfessionalParams, response: { 200: PublicBookingPageDto } },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        const page = await run(tenant, async (tx) => {
          const settings = await readBookingSettings(tx);
          const offer = await findProfessionalOffer(
            tx,
            {
              organizationSlug: request.params.slug,
              professionalSlug: request.params.professionalSlug,
            },
            offerContext(tenant, settings),
          );
          if (!offer) return null;
          return pageOf('professional', await readOrganizationName(tx), settings, [offer]);
        });
        return page ?? denied(request, reply);
      },
    );

    /** Free slots after `from`, for the answer of a slot that was just taken. */
    async function alternatives(
      tenant: ResolvedTenant,
      request: FastifyRequest,
      input: {
        organizationSlug: string;
        professionalSlug: string;
        typeId: string;
        locationId: string;
        startsAt: string;
      },
    ): Promise<{ startsAt: string; endsAt: string }[]> {
      try {
        const slots = await run(tenant, async (tx) => {
          const settings = await readBookingSettings(tx);
          const offer = await findProfessionalOffer(
            tx,
            { organizationSlug: input.organizationSlug, professionalSlug: input.professionalSlug },
            offerContext(tenant, settings),
          );
          if (!offer) return [];
          const from = input.startsAt.slice(0, 10);
          const to = new Date(Date.parse(`${from}T00:00:00Z`) + 14 * 86_400_000)
            .toISOString()
            .slice(0, 10);
          const answer = await publicAvailability(tx, {
            offer,
            query: { typeId: input.typeId, locationId: input.locationId, from, to },
            settings: settings.booking,
            now: deps.clock(),
            ports: deps.portsOf(tx),
          });
          return (answer?.slots ?? []).filter(
            (slot: PublicSlotDto) => Date.parse(slot.startsAt) !== Date.parse(input.startsAt),
          );
        });
        return slots
          .filter((slot) => Date.parse(slot.startsAt) > Date.parse(input.startsAt))
          .slice(0, NEXT_SLOTS)
          .map(({ startsAt, endsAt }) => ({ startsAt, endsAt }));
      } catch (error) {
        request.log.warn({ code: (error as { code?: unknown } | null)?.code }, 'no alternatives');
        return [];
      }
    }

    typed.get(
      '/public/:slug/booking/availability',
      {
        config: {
          readOnly: 'read',
          auth: 'public',
          rateLimit: { max: 120, timeWindow: 60_000 },
        },
        schema: {
          params: PageParams,
          querystring: PublicAvailabilityQuery,
          response: { 200: PublicAvailabilityResponse },
        },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        const { professional: professionalSlug, ...query } = request.query;
        const answer = await run(tenant, async (tx) => {
          const settings = await readBookingSettings(tx);
          const offer = await findProfessionalOffer(
            tx,
            { organizationSlug: request.params.slug, professionalSlug },
            offerContext(tenant, settings),
          );
          if (!offer) return null;
          const key = [
            request.params.slug,
            professionalSlug,
            query.typeId,
            query.locationId ?? '',
            query.from,
            query.to,
          ].join('|');
          try {
            return await deps.availabilityCache.get(tenant.id, key, async () => {
              const found = await publicAvailability(tx, {
                offer,
                query,
                settings: settings.booking,
                now: deps.clock(),
                ports: deps.portsOf(tx),
              });
              // A type or a location the link does not expose looks like an address that is not live.
              if (!found) throw new AppError('not_found');
              return found;
            });
          } catch (error) {
            // An inactive type or professional (scheduling answers conflict) is simply unavailable.
            if (error instanceof AppError) return null;
            throw error;
          }
        });
        return answer ?? denied(request, reply);
      },
    );

    typed.post(
      '/public/:slug/booking/holds',
      {
        config: {
          readOnly: 'write',
          auth: 'public',
          audits: 'none',
          rateLimit: { max: 20, timeWindow: 60_000 },
        },
        schema: { params: PageParams, body: PublicHoldRequest, response: { 201: PublicHoldDto } },
      },
      async (request, reply) => {
        const tenant = tenantOf(request);
        void reply.header('cache-control', 'no-store');
        // The bot challenge comes first: nothing else is spent on a request that fails it.
        const solved = await challengeOf(tenant).verify(request.body.challengeProof, request.ip);
        if (!solved) throw new AppError('booking_challenge_failed');

        const secure = secureCookies(tenant);
        const known = readBookingSession(request.headers.cookie, { secure });
        const sessionId = known ?? newBookingSessionId();
        try {
          const hold = await run(tenant, async (tx) => {
            const settings = await readBookingSettings(tx);
            const offer = await findProfessionalOffer(
              tx,
              {
                organizationSlug: request.params.slug,
                professionalSlug: request.body.professional,
              },
              offerContext(tenant, settings),
            );
            if (!offer) return null;
            return createPublicHold(tx, {
              offer,
              request: request.body,
              settings: settings.booking,
              now: deps.clock(),
              sourceKey: sourceKeyOf(sessionId),
              ports: deps.portsOf(tx),
            });
          });
          if (!hold) return await denied(request, reply);
          deps.availabilityCache.invalidate(tenant.id);
          if (known === null) {
            void reply.header(
              'set-cookie',
              serializeBookingSession(sessionId, { secure, maxAgeSeconds: SESSION_SECONDS }),
            );
          }
          return await reply.code(201).send(hold);
        } catch (error) {
          return refusal(error, request, reply, tenant, {
            organizationSlug: request.params.slug,
            professionalSlug: request.body.professional,
            typeId: request.body.appointmentTypeId,
            locationId: request.body.locationId,
            startsAt: request.body.startsAt,
          });
        }
      },
    );

    const IdParams = z.strictObject({ slug: SlugParam, id: z.uuid() });
    const submissionDeps: SubmissionDeps = { keys: deps.keys, jobs: deps.jobs, abuse: deps.abuse };

    /** Turns what the use case decided into the answer: one shape for every visitor. */
    function answerFor(
      outcome: SubmitOutcome,
      request: FastifyRequest,
      reply: FastifyReply,
    ): FastifyReply | PublicSubmissionResponse {
      if (outcome.ok) {
        return {
          maskedEmail: outcome.maskedEmail,
          codeExpiresAt: outcome.codeExpiresAt.toISOString(),
        };
      }
      switch (outcome.refusal) {
        case 'not_found':
          return denied(request, reply);
        case 'expired':
          return conflictCode(request, reply, 'slot_no_longer_available');
        case 'rate_limited':
          throw new AppError('rate_limited');
        case 'limit_reached':
          throw new AppError('booking_limit_reached');
      }
    }

    /** What both routes of the form need before the use case runs. */
    async function formContext(
      request: FastifyRequest & { params: { slug: string; id: string } },
      reply: FastifyReply,
      proof: string,
    ) {
      const tenant = tenantOf(request);
      void reply.header('cache-control', 'no-store');
      // The bot challenge comes first: nothing else is spent on a request that fails it.
      if (!(await challengeOf(tenant).verify(proof, request.ip))) {
        throw new AppError('booking_challenge_failed');
      }
      const sessionId = readBookingSession(request.headers.cookie, {
        secure: secureCookies(tenant),
      });
      return { tenant, sessionId };
    }

    typed.post(
      '/public/:slug/booking/holds/:id/submission',
      {
        config: {
          readOnly: 'write',
          auth: 'public',
          audits: 'none',
          rateLimit: { max: 20, timeWindow: 60_000 },
        },
        schema: {
          params: IdParams,
          body: PublicSubmissionRequest,
          response: { 200: PublicSubmissionResponse },
        },
      },
      async (request, reply) => {
        const { challengeProof, ...form } = request.body;
        const { tenant, sessionId } = await formContext(request, reply, challengeProof);
        if (sessionId === null) return denied(request, reply);
        const outcome = await run(tenant, async (tx) => {
          const settings = await readBookingSettings(tx);
          return submitBooking(tx, submissionDeps, {
            tenant: { id: tenant.id, country: tenant.country },
            organizationSlug: request.params.slug,
            holdId: request.params.id,
            sourceKey: sourceKeyOf(sessionId),
            ip: request.ip,
            actor: request.auditActor,
            now: deps.clock(),
            offerContext: offerContext(tenant, settings),
            form,
          });
        });
        return answerFor(outcome, request, reply);
      },
    );

    typed.post(
      '/public/:slug/booking/holds/:id/code',
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
          response: { 200: PublicSubmissionResponse },
        },
      },
      async (request, reply) => {
        const { tenant, sessionId } = await formContext(
          request,
          reply,
          request.body.challengeProof,
        );
        if (sessionId === null) return denied(request, reply);
        const outcome = await run(tenant, async (tx) => {
          const settings = await readBookingSettings(tx);
          return resendCode(tx, submissionDeps, {
            tenant: { id: tenant.id, country: tenant.country },
            organizationSlug: request.params.slug,
            holdId: request.params.id,
            sourceKey: sourceKeyOf(sessionId),
            ip: request.ip,
            actor: request.auditActor,
            now: deps.clock(),
            offerContext: offerContext(tenant, settings),
          });
        });
        return answerFor(outcome, request, reply);
      },
    );

    /** Turns the refusals of scheduling into the answers the public sees: no range, no reason. */
    async function refusal(
      error: unknown,
      request: FastifyRequest,
      reply: FastifyReply,
      tenant: ResolvedTenant,
      slot: Parameters<typeof alternatives>[2],
    ): Promise<FastifyReply> {
      if (error instanceof SlotTakenError) {
        return conflictCode(request, reply, 'slot_taken', {
          nextSlots: await alternatives(tenant, request, slot),
        });
      }
      if (error instanceof SlotNoLongerAvailableError) {
        return conflictCode(request, reply, 'slot_no_longer_available', {
          nextSlots: await alternatives(tenant, request, slot),
        });
      }
      throw error;
    }
  };
}

export type { OnlineBookingSettings };
