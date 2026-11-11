import {
  PublicChallengeResponse,
  SignupAcceptedResponse,
  SignupVerifiedResponse,
  type SignupRequest,
  type SignupVerifyRequest,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../../shared/lib/api-client.js';

/**
 * What the signup asks the API. No session and no organization of its own: the form talks to the
 * platform host, and the page of the emailed link to the host of the organization it activates.
 */
export function signupApi(api: ApiClient) {
  return {
    /** The bot challenge, from the platform host or from an unverified organization's host. */
    challenge: () => api.get('/public/signup/challenge', { schema: PublicChallengeResponse }),
    signUp: (body: SignupRequest) =>
      api.post('/public/signup', { body, schema: SignupAcceptedResponse }),
    /** A new link by the address of the signup (platform host). */
    resend: (email: string, challengeProof: string) =>
      api.post('/public/signup/resend', {
        body: { email, challengeProof },
        schema: SignupAcceptedResponse,
      }),
    /** A new link from the page of the old one (the host names the organization). */
    renew: (challengeProof: string) =>
      api.post('/public/signup/renew', {
        body: { challengeProof },
        schema: SignupAcceptedResponse,
      }),
    /**
     * Follows the link with the password the owner chose and the two acceptances: the organization
     * is active and the owner is signed in (cookie).
     */
    verify: (body: SignupVerifyRequest) =>
      api.post('/public/signup/verify', { body, schema: SignupVerifiedResponse }),
  };
}
