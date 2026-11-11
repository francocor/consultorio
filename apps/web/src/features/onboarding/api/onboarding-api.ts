import {
  FastPathResponse,
  InvitationImpactDto,
  OnboardingStateDto,
  type FastPathRequest,
  type ProfessionalStepRequest,
  type StaffRole,
  type UpdateOnboardingStateRequest,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export const onboardingKeys = {
  all: ['onboarding'] as const,
  state: ['onboarding', 'state'] as const,
};

/** The onboarding module of the API: wizard progress, the solo fast path and the checklist. */
export function onboardingApi(api: ApiClient) {
  return {
    state: () => api.get('/onboarding/state', { schema: OnboardingStateDto }),
    update: (body: UpdateOnboardingStateRequest) =>
      api.put('/onboarding/state', { body, schema: OnboardingStateDto }),
    professional: (body: ProfessionalStepRequest) =>
      api.post('/onboarding/professional', { body, schema: OnboardingStateDto }),
    fastPath: (body: FastPathRequest) =>
      api.post('/onboarding/fast-path', { body, schema: FastPathResponse }),
    complete: () => api.post('/onboarding/complete', { schema: OnboardingStateDto }),
    /** What inviting these roles would change in the plan, asked before sending. */
    invitationImpact: (roles: readonly StaffRole[]) =>
      api.get('/onboarding/invitation-impact', {
        query: { roles: roles.join(',') },
        schema: InvitationImpactDto,
      }),
  };
}
