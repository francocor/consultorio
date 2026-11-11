import {
  AppointmentConsentStatusDto,
  ConsentListResponse,
  ConsentRequestDto,
  ConsentRequirementDto,
  ConsentRequirementsResponse,
  ConsentSigningViewDto,
  ConsentStartersResponse,
  ConsentTemplateDetailResponse,
  ConsentTemplateDto,
  ConsentTemplateListResponse,
  CreateConsentRequestResponse,
  OfferedConsentTemplatesResponse,
  SignedConsentDto,
  type CreateConsentRequestRequest,
  type CreateConsentTemplateRequest,
  type RevokeConsentRequest,
  type SetConsentRequirementRequest,
  type SignConsentRequest,
  type UpdateConsentTemplateRequest,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export const consentKeys = {
  all: ['consent'] as const,
  templates: ['consent', 'templates'] as const,
  template: (id: string) => ['consent', 'templates', id] as const,
  starters: ['consent', 'starters'] as const,
  offered: ['consent', 'offered'] as const,
  requirements: ['consent', 'requirements'] as const,
  patient: (patientId: string) => ['consent', 'patient', patientId] as const,
  signing: (requestId: string) => ['consent', 'signing', requestId] as const,
  record: (requestId: string) => ['consent', 'record', requestId] as const,
  appointment: (appointmentId: string) => ['consent', 'appointment', appointmentId] as const,
};

/** What the consent screens ask of the API. */
export function consentApi(api: ApiClient) {
  return {
    // Templates ----------------------------------------------------------------------------
    templates: () => api.get('/consent/templates', { schema: ConsentTemplateListResponse }),
    template: (id: string) =>
      api.get(`/consent/templates/${id}`, { schema: ConsentTemplateDetailResponse }),
    starters: () => api.get('/consent/starters', { schema: ConsentStartersResponse }),
    createTemplate: (body: CreateConsentTemplateRequest) =>
      api.post('/consent/templates', { body, schema: ConsentTemplateDto }),
    updateTemplate: (id: string, body: UpdateConsentTemplateRequest) =>
      api.patch(`/consent/templates/${id}`, { body, schema: ConsentTemplateDetailResponse }),
    publishTemplate: (id: string) =>
      api.post(`/consent/templates/${id}/publish`, { schema: ConsentTemplateDetailResponse }),
    retireTemplate: (id: string) =>
      api.post(`/consent/templates/${id}/retire`, { schema: ConsentTemplateDetailResponse }),
    offered: () =>
      api.get('/consent/offered-templates', { schema: OfferedConsentTemplatesResponse }),

    // The consent an appointment type requires ----------------------------------------------
    requirements: () =>
      api.get('/consent/appointment-types', { schema: ConsentRequirementsResponse }),
    setRequirement: (appointmentTypeId: string, body: SetConsentRequirementRequest) =>
      api.put(`/consent/appointment-types/${appointmentTypeId}`, {
        body,
        schema: ConsentRequirementDto,
      }),
    appointmentStatus: (appointmentId: string) =>
      api.get(`/appointments/${appointmentId}/consent-status`, {
        schema: AppointmentConsentStatusDto,
      }),

    // Requests, signing and revocation ------------------------------------------------------
    ofPatient: (patientId: string) =>
      api.get(`/patients/${patientId}/consents`, { schema: ConsentListResponse }),
    request: (body: CreateConsentRequestRequest) =>
      api.post('/consents/requests', { body, schema: CreateConsentRequestResponse }),
    signingView: (requestId: string) =>
      api.get(`/consents/requests/${requestId}/signing`, { schema: ConsentSigningViewDto }),
    sign: (requestId: string, body: SignConsentRequest) =>
      api.post(`/consents/requests/${requestId}/sign`, { body, schema: ConsentRequestDto }),
    decline: (requestId: string) =>
      api.post(`/consents/requests/${requestId}/decline`, { schema: ConsentRequestDto }),
    revoke: (requestId: string, body: RevokeConsentRequest) =>
      api.post(`/consents/requests/${requestId}/revoke`, { body, schema: ConsentRequestDto }),
    record: (requestId: string) =>
      api.get(`/consents/requests/${requestId}`, { schema: SignedConsentDto }),
    document: (requestId: string) => api.download(`/consents/requests/${requestId}/document`),
  };
}
