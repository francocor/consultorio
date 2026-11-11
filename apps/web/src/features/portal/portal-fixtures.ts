import type { PortalLinkDto, PortalMeResponse } from '@consultorio/contracts';

import { jsonResponse, problemResponse, type FetchHandler } from '../../shared/test/render.js';

/** The data the portal tests use: a patient with one record, and what the server answers about it. */

export const SELF_LINK: PortalLinkDto = {
  id: '0190a000-0000-7000-8000-0000000000a1',
  patientId: '0190a000-0000-7000-8000-0000000000b1',
  patientName: 'Ana Pérez',
  relationship: 'self',
  relation: null,
  status: 'active',
  majorityReviewOn: null,
  createdAt: '2031-05-01T12:00:00.000Z',
};

export const CHILD_LINK: PortalLinkDto = {
  id: '0190a000-0000-7000-8000-0000000000a2',
  patientId: '0190a000-0000-7000-8000-0000000000b2',
  patientName: 'Beto Pérez',
  relationship: 'representative',
  relation: 'mother',
  status: 'active',
  majorityReviewOn: '2038-09-14',
  createdAt: '2031-05-02T12:00:00.000Z',
};

export function meOf(
  links: readonly PortalLinkDto[],
  selectedLinkId: string | null,
  overrides: Partial<PortalMeResponse> = {},
): PortalMeResponse {
  return {
    email: 'ana@example.test',
    organizationName: 'Centro Médico Aillu',
    links: [...links],
    selectedLinkId,
    capabilities: { consents: true, prescriptions: true },
    ...overrides,
  };
}

/** A network where the patient is signed in with one record. */
export function signedInRoutes(
  me: PortalMeResponse = meOf([SELF_LINK], SELF_LINK.id),
  extra: Record<string, FetchHandler | Response> = {},
): Record<string, FetchHandler | Response> {
  return {
    'GET /api/public/challenge': jsonResponse({ kind: 'fake', payload: {} }),
    'GET /api/portal/me': jsonResponse(me),
    'POST /api/portal/logout': new Response(null, { status: 204 }),
    ...extra,
  };
}

/** A network where nobody is signed in: the portal opens on the sign-in. */
export function signedOutRoutes(
  extra: Record<string, FetchHandler | Response> = {},
): Record<string, FetchHandler | Response> {
  return {
    'GET /api/public/challenge': jsonResponse({ kind: 'fake', payload: {} }),
    'GET /api/portal/me': problemResponse(401, 'unauthenticated'),
    ...extra,
  };
}
