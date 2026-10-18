import {
  PublicAvailabilityResponse,
  PublicBookingPageDto,
  PublicChallengeResponse,
  PublicConfirmationDto,
  PublicHoldDto,
  PublicManageDto,
  PublicSubmissionResponse,
  type PublicHoldRequest,
  type PublicSubmissionRequest,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export const bookingKeys = {
  all: ['public-booking'] as const,
  page: (slug: string, professional: string | null) =>
    ['public-booking', 'page', slug, professional ?? ''] as const,
  availability: (slug: string, professional: string, typeId: string, locationId: string) =>
    ['public-booking', 'availability', slug, professional, typeId, locationId] as const,
  manage: (token: string) => ['public-booking', 'manage', token] as const,
  manageSlots: (token: string) => ['public-booking', 'manage-slots', token] as const,
};

const enc = encodeURIComponent;

/** What a visitor of the public booking pages asks the API. No session, no cookie of ours. */
export function publicBookingApi(api: ApiClient) {
  return {
    challenge: () => api.get('/public/challenge', { schema: PublicChallengeResponse }),

    organizationPage: (slug: string) =>
      api.get(`/public/${enc(slug)}/booking`, { schema: PublicBookingPageDto }),

    professionalPage: (slug: string, professional: string) =>
      api.get(`/public/${enc(slug)}/p/${enc(professional)}`, { schema: PublicBookingPageDto }),

    availability: (
      slug: string,
      query: {
        professional: string;
        typeId: string;
        locationId: string;
        from: string;
        to: string;
      },
    ) =>
      api.get(`/public/${enc(slug)}/booking/availability`, {
        query,
        schema: PublicAvailabilityResponse,
      }),

    hold: (slug: string, body: PublicHoldRequest) =>
      api.post(`/public/${enc(slug)}/booking/holds`, { body, schema: PublicHoldDto }),

    submit: (slug: string, holdId: string, body: PublicSubmissionRequest) =>
      api.post(`/public/${enc(slug)}/booking/holds/${enc(holdId)}/submission`, {
        body,
        schema: PublicSubmissionResponse,
      }),

    resend: (slug: string, holdId: string, challengeProof: string) =>
      api.post(`/public/${enc(slug)}/booking/holds/${enc(holdId)}/code`, {
        body: { challengeProof },
        schema: PublicSubmissionResponse,
      }),

    confirm: (slug: string, holdId: string, code: string) =>
      api.post(`/public/${enc(slug)}/booking/holds/${enc(holdId)}/confirm`, {
        body: { code },
        schema: PublicConfirmationDto,
      }),

    // The link in the confirmation: look at the appointment, move it or cancel it.
    manage: (token: string) =>
      api.get(`/public/t/${enc(token)}/appointment`, { schema: PublicManageDto }),

    manageSlots: (token: string, range: { from: string; to: string }) =>
      api.get(`/public/t/${enc(token)}/slots`, {
        query: range,
        schema: PublicAvailabilityResponse,
      }),

    reschedule: (token: string, startsAt: string) =>
      api.post(`/public/t/${enc(token)}/reschedule`, {
        body: { startsAt },
        schema: PublicConfirmationDto,
      }),

    cancel: (token: string) =>
      api.post(`/public/t/${enc(token)}/cancel`, { body: {}, schema: PublicManageDto }),
  };
}

export type PublicBookingApi = ReturnType<typeof publicBookingApi>;
