import {
  PublicWaitlistJoinedResponse,
  PublicWaitlistJoinResponse,
  type PublicWaitlistJoinRequest,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../../shared/lib/api-client.js';

const enc = encodeURIComponent;

/** What a visitor who joins the waitlist asks the API. No session, no cookie of ours. */
export function waitlistJoinApi(api: ApiClient) {
  return {
    /** Sends the form; the code goes to the address in it. Nothing is created yet. */
    join: (slug: string, body: PublicWaitlistJoinRequest) =>
      api.post(`/public/${enc(slug)}/waitlist`, { body, schema: PublicWaitlistJoinResponse }),

    resend: (slug: string, id: string, challengeProof: string) =>
      api.post(`/public/${enc(slug)}/waitlist/${enc(id)}/code`, {
        body: { challengeProof },
        schema: PublicWaitlistJoinResponse,
      }),

    /** The code arrived: only now is the visitor on the list. */
    confirm: (slug: string, id: string, code: string) =>
      api.post(`/public/${enc(slug)}/waitlist/${enc(id)}/confirm`, {
        body: { code },
        schema: PublicWaitlistJoinedResponse,
      }),
  };
}
