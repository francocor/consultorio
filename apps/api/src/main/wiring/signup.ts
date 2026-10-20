import { createSignup, createSignupWorker } from '../../modules/onboarding/index.js';
import { createTrialStarter, type TrialStarter } from '../../modules/subscriptions/index.js';

import { originsFromConfig } from './origins.js';
import type { ModuleWiring } from './types.js';

/** How often the worker looks for signups whose verification email never went out. */
const RETRY_EVERY_MS = 60_000;
/** How often the worker removes the signups nobody confirmed (they are removed after seven days). */
const PURGE_EVERY_MS = 6 * 3_600_000;

/**
 * Everything the signup registers with the composition root (Track B). It mounts its routes behind
 * the `signup` feature (`featureRoutes`), so a single-tenant deployment has none, and adds two
 * passes to the worker: the purge of the signups nobody confirmed (`signup.purge`, seven days,
 * retention exception 2) and the retry of the verification emails. They are passes of the worker and
 * not jobs of an organization on purpose: a `write` job is cancelled for an organization that is not
 * active, and the purge deletes exactly those. The signup owns no external provider (the bot
 * challenge and the email are shared ports). Its audit actions, queue, the `signup_verification`
 * token kind and the trial door already exist.
 *
 * The wiring is named `signup` and not `onboarding`: the onboarding module itself is built by the
 * composition root, and the signup is the part of it that only exists in multi mode.
 */
export function createSignupWiring(
  options: {
    /**
     * The door that starts the trial. The composition root passes none and gets the one of the
     * subscriptions module; a test passes a double that records the call.
     */
    trial?: TrialStarter;
  } = {},
): ModuleWiring {
  return {
    name: 'signup',
    create: (context) => {
      const signup = createSignup({
        withTenant: context.withTenant,
        auditDeny: context.auditDeny,
        keys: context.keys,
        email: context.email,
        origins: context.origins,
        rateLimitStore: context.rateLimitStore,
        jobs: context.jobs,
        adapters: context.adapters,
        // The door of the subscription: it starts the trial in the transaction of the verification.
        // Until the subscriptions track builds it, it refuses, so no organization is activated
        // without a plan (see `docs/stage6-tracks.md`).
        trial: options.trial ?? createTrialStarter(),
        accounts: context.accounts,
        ...(context.clock ? { clock: context.clock } : {}),
      });
      return { featureRoutes: { signup: signup.routes } };
    },
    worker: ({ config, email, clock }) => {
      const origins = originsFromConfig(config);
      return {
        schedules: ({ db, log }) => {
          const housekeeping = createSignupWorker({
            db,
            email,
            origins,
            ...(clock ? { clock } : {}),
            onError: (code) => {
              log.error({ code }, 'a verification email of a signup could not be sent');
            },
          });
          return [
            {
              name: 'signup verification retry',
              intervalMs: RETRY_EVERY_MS,
              run: async () => {
                await housekeeping.retryVerifications();
              },
            },
            {
              name: 'signup.purge pass',
              intervalMs: PURGE_EVERY_MS,
              run: async () => {
                const purged = await housekeeping.purgeUnverified();
                if (purged > 0) log.info({ purged }, 'unverified signups removed');
              },
            },
          ];
        },
      };
    },
  };
}

export const signupWiring: ModuleWiring = createSignupWiring();
