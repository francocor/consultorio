import { createSignup } from '../../modules/onboarding/index.js';
import { createTrialStarter } from '../../modules/subscriptions/index.js';

import type { ModuleWiring } from './types.js';

/**
 * Everything the signup registers with the composition root (Track B). The track edits this file,
 * `modules/onboarding/signup/` and nothing shared: it sets `needsJobs` for the retry of the
 * verification email, adds the purge job (`signup.purge`, seven days) to the worker and mounts its
 * routes behind the `signup` feature (`featureRoutes`), so a single-tenant deployment has none. The
 * signup owns no external provider (the bot challenge and the email are shared ports). Its audit
 * actions, queue, the `signup_verification` token kind and the trial door already exist.
 *
 * The wiring is named `signup` and not `onboarding`: the onboarding module itself is built by the
 * composition root, and the signup is the part of it that only exists in multi mode.
 */
export const signupWiring: ModuleWiring = {
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
      // Until S6.01 the door refuses, so no organization is activated without a trial.
      trial: createTrialStarter(),
      ...(context.clock ? { clock: context.clock } : {}),
    });
    return { featureRoutes: { signup: signup.routes } };
  },
};
