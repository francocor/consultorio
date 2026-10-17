import { z } from 'zod';

import type { Tx } from '../../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import { JobPayload, type JobClient } from '../../../platform/jobs/boss.js';
import { defineJob } from '../../../platform/jobs/define-job.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import type { SchedulingPorts } from '../../scheduling/index.js';

import { deliverOffer } from './delivery.js';
import { expireOffer, sweepWaitlist } from './expiry.js';
import { matchFreedSlot } from './match.js';
import { WAITLIST_EXPIRE_JOB, WAITLIST_OFFER_JOB } from './offers.js';
import type { DeliverWaitlistOffer } from './ports.js';
import { WAITLIST_MATCH_JOB } from './trigger.js';

/** What the jobs of the waitlist are built from. The worker and the tests build them the same way. */
export interface WaitlistJobDeps {
  /** Scheduling's view of the organization, for the transaction of a job. */
  portsOf(tx: Tx): SchedulingPorts;
  /** Enqueues what follows an offer (its delivery, its expiry, the next match). */
  jobs: JobClient;
  clock: () => Date;
  tokens: ActionTokens;
  /** Where the link of an offer points. */
  origins: PublicOrigins;
  /** Sends an offer to the patient; see `DeliverWaitlistOffer`. */
  deliver: DeliverWaitlistOffer;
}

const MatchPayload = JobPayload.extend({
  professionalId: z.uuid().nullable(),
  locationId: z.uuid().nullable(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  cause: z.enum(['cancelled', 'rescheduled', 'reassigned', 'block_removed', 'offer_ended']),
});

const OfferPayload = JobPayload.extend({ offerId: z.uuid() });
/** An offer id closes that offer if it is due; none is the sweep of the whole organization. */
const ExpirePayload = JobPayload.extend({ offerId: z.uuid().optional() });

export function createWaitlistJobs(deps: WaitlistJobDeps) {
  /**
   * `waitlist.match`: a range of time came free (or an offer for it ended): find who it can be
   * offered to. Idempotent: a repeated job finds the offer already open and does nothing. It is a
   * write job, so a read-only organization makes no offers.
   */
  const match = defineJob({
    name: WAITLIST_MATCH_JOB,
    category: 'write',
    payload: MatchPayload,
    handler: async ({ tx, payload }) => {
      await matchFreedSlot(
        tx,
        { portsOf: (tx) => deps.portsOf(tx), jobs: deps.jobs },
        {
          professionalId: payload.professionalId,
          locationId: payload.locationId,
          startsAt: new Date(payload.startsAt),
          endsAt: new Date(payload.endsAt),
          now: deps.clock(),
        },
      );
    },
  });

  /**
   * `waitlist.offer`: sends one offer to the patient, when it is due (right away, or at the end of
   * quiet hours). Idempotent: an offer that was delivered, or that is no longer open, is skipped.
   */
  const offer = defineJob({
    name: WAITLIST_OFFER_JOB,
    category: 'write',
    payload: OfferPayload,
    handler: async ({ tx, payload }) => {
      await deliverOffer(
        tx,
        {
          portsOf: (inner) => deps.portsOf(inner),
          jobs: deps.jobs,
          tokens: deps.tokens,
          origins: deps.origins,
          deliver: deps.deliver,
        },
        { offerId: payload.offerId, now: deps.clock() },
      );
    },
  });

  /**
   * `waitlist.expire`: an offer ran out of time (queued for its exact expiry), or the minutely
   * sweep of the organization (no offer named): the offers that are due, and the entries that ran
   * out. The next entry in line is offered the slot by the match this queues.
   */
  const expire = defineJob({
    name: WAITLIST_EXPIRE_JOB,
    category: 'write',
    payload: ExpirePayload,
    handler: async ({ tx, payload }) => {
      const now = deps.clock();
      if (payload.offerId === undefined) {
        await sweepWaitlist(tx, { jobs: deps.jobs }, { now });
      } else {
        await expireOffer(tx, { jobs: deps.jobs }, { offerId: payload.offerId, now });
      }
    },
  });

  return { match, offer, expire };
}

export type WaitlistJobs = ReturnType<typeof createWaitlistJobs>;
