import { useQuery } from '@tanstack/react-query';

import { useApi } from '../../app/providers.js';
import { useMe } from '../../app/session.js';

import { onboardingApi, onboardingKeys } from './api/onboarding-api.js';

/** True when the signed-in person runs the first run (the owner, or an admin with the grant). */
export function useRunsOnboarding(): boolean {
  return useMe().permissions.includes('onboarding.manage');
}

/**
 * The progress of the first run. Nothing is requested for a person who does not run it, so
 * reception never causes a call (and never sees an error) for a screen that is not theirs.
 */
export function useOnboardingState() {
  const api = useApi();
  const enabled = useRunsOnboarding();
  return useQuery({
    queryKey: onboardingKeys.state,
    queryFn: () => onboardingApi(api).state(),
    enabled,
  });
}
