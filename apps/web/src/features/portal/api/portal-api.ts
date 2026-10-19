import {
  DocumentPortalShareResponse,
  PatientPortalResponse,
  PortalAcceptedResponse,
  PortalAppointmentResponse,
  PortalAppointmentsResponse,
  PortalConsentDetailDto,
  PortalConsentResponse,
  PortalConsentsResponse,
  PortalDocumentsResponse,
  PortalDownloadLinkResponse,
  PortalIdentityResponse,
  PortalInvoicesResponse,
  PortalMeResponse,
  PortalPrescriptionsResponse,
  PortalProfileResponse,
  PortalRepresentativesResponse,
  PortalRequestResponse,
  PortalSessionsResponse,
  PortalSignedInResponse,
  type PortalConsentSignRequest,
  type PortalCopyRequest,
  type PortalProfileUpdateRequest,
  type PortalRectificationRequest,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

/**
 * The query keys of the portal. Everything a section reads is keyed by the record that is shown, so
 * the data of one person is never served for another when a representative switches.
 */
export const portalKeys = {
  all: ['portal'] as const,
  me: ['portal', 'me'] as const,
  section: (linkId: string | null, name: string, extra?: string) =>
    ['portal', 'subject', linkId ?? 'none', name, ...(extra === undefined ? [] : [extra])] as const,
  sessions: ['portal', 'sessions'] as const,
  staff: (patientId: string) => ['portal', 'staff', patientId] as const,
};

const enc = encodeURIComponent;

/**
 * The slug of the public prefix (`/public/:slug/portal/...`). The API never reads it: the
 * organization is the host's. The browser cannot know the slug of the organization anyway.
 */
const PREFIX = '/public/_/portal';

export type DownloadKind = 'documents' | 'prescriptions' | 'invoices' | 'consents';

/** What the patient portal asks the API. The session is a cookie the browser keeps. */
export function portalApi(api: ApiClient) {
  return {
    // Signing in and registering (no session yet) --------------------------------------------------
    requestCode: (email: string, challengeProof: string) =>
      api.post(`${PREFIX}/otp`, {
        body: { email, challengeProof },
        schema: PortalAcceptedResponse,
      }),
    verifyCode: (email: string, code: string) =>
      api.post(`${PREFIX}/otp/verify`, { body: { email, code }, schema: PortalSignedInResponse }),
    requestRegistration: (nationalId: string, email: string, challengeProof: string) =>
      api.post(`${PREFIX}/register`, {
        body: { nationalId, email, challengeProof },
        schema: PortalAcceptedResponse,
      }),
    verifyRegistration: (nationalId: string, email: string, code: string) =>
      api.post(`${PREFIX}/register/verify`, {
        body: { nationalId, email, code },
        schema: PortalSignedInResponse,
      }),

    // Who is signed in -----------------------------------------------------------------------------
    me: () => api.get('/portal/me', { schema: PortalMeResponse }),
    selectSubject: (linkId: string) =>
      api.post('/portal/subject', { body: { linkId }, schema: PortalMeResponse }),
    logout: () => api.post('/portal/logout'),
    sessions: () => api.get('/portal/sessions', { schema: PortalSessionsResponse }),
    endSession: (id: string) => api.delete(`/portal/sessions/${enc(id)}`),

    // The sections --------------------------------------------------------------------------------
    appointments: () => api.get('/portal/appointments', { schema: PortalAppointmentsResponse }),
    confirmAppointment: (id: string) =>
      api.post(`/portal/appointments/${enc(id)}/confirm`, {
        body: {},
        schema: PortalAppointmentResponse,
      }),
    cancelAppointment: (id: string) =>
      api.post(`/portal/appointments/${enc(id)}/cancel`, {
        body: {},
        schema: PortalAppointmentResponse,
      }),
    documents: () => api.get('/portal/documents', { schema: PortalDocumentsResponse }),
    invoices: () => api.get('/portal/invoices', { schema: PortalInvoicesResponse }),
    consents: () => api.get('/portal/consents', { schema: PortalConsentsResponse }),
    consent: (id: string) =>
      api.get(`/portal/consents/${enc(id)}`, { schema: PortalConsentDetailDto }),
    signConsent: (id: string, body: PortalConsentSignRequest) =>
      api.post(`/portal/consents/${enc(id)}/sign`, { body, schema: PortalConsentResponse }),
    revokeConsent: (id: string, reason: string | undefined) =>
      api.post(`/portal/consents/${enc(id)}/revoke`, {
        body: reason === undefined || reason === '' ? {} : { reason },
        schema: PortalConsentResponse,
      }),
    prescriptions: () => api.get('/portal/prescriptions', { schema: PortalPrescriptionsResponse }),

    // Downloads: a link for this session, then the file itself --------------------------------------
    downloadLink: (kind: DownloadKind, id: string) =>
      api.post(`/portal/${kind}/${enc(id)}/download-link`, {
        body: {},
        schema: PortalDownloadLinkResponse,
      }),
    file: (url: string) => api.download(url),

    // The patient's own data -----------------------------------------------------------------------
    profile: () => api.get('/portal/profile', { schema: PortalProfileResponse }),
    updateProfile: (body: PortalProfileUpdateRequest) =>
      api.patch('/portal/profile', { body, schema: PortalProfileResponse }),
    rectification: (body: PortalRectificationRequest) =>
      api.post('/portal/rectification-requests', { body, schema: PortalRequestResponse }),
    copyRequest: (body: PortalCopyRequest) =>
      api.post('/portal/copy-requests', { body, schema: PortalRequestResponse }),
    representatives: () =>
      api.get('/portal/representatives', { schema: PortalRepresentativesResponse }),
    authorizeLink: (id: string) => api.post(`/portal/links/${enc(id)}/authorize`, { body: {} }),
    revokeLink: (id: string) => api.post(`/portal/links/${enc(id)}/revoke`, { body: {} }),
  };
}

/** What the staff screen of a patient asks (the invitation tab of the patient record). */
export function portalStaffApi(api: ApiClient) {
  return {
    accounts: (patientId: string) =>
      api.get(`/patients/${enc(patientId)}/portal`, { schema: PatientPortalResponse }),
    invite: (patientId: string, body: Record<string, unknown>) =>
      api.post(`/patients/${enc(patientId)}/portal-invitation`, {
        body,
        schema: PortalIdentityResponse,
      }),
    deactivate: (identityId: string) =>
      api.post(`/portal-identities/${enc(identityId)}/deactivate`, {
        body: {},
        schema: PortalIdentityResponse,
      }),
    revokeLink: (linkId: string) =>
      api.post(`/portal-links/${enc(linkId)}/revoke`, { body: {}, schema: PortalIdentityResponse }),
    revokeSessions: (identityId: string) =>
      api.post(`/portal-identities/${enc(identityId)}/sessions/revoke`, {
        body: {},
        schema: PortalIdentityResponse,
      }),
    share: (documentId: string) =>
      api.post(`/documents/${enc(documentId)}/portal-share`, {
        body: {},
        schema: DocumentPortalShareResponse,
      }),
    unshare: (documentId: string) =>
      api.delete(`/documents/${enc(documentId)}/portal-share`, {
        schema: DocumentPortalShareResponse,
      }),
  };
}
