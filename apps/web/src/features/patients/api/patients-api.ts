import {
  AnamnesisResponse,
  AnamnesisVersionDto,
  AssignmentDto,
  AssignmentListResponse,
  ConsentRecordDto,
  ConsentResponse,
  CoverageDto,
  CoverageListResponse,
  CreatePatientResponse,
  FulfillRightsResponse,
  PatientDto,
  PatientHistoryResponse,
  PatientSearchResponse,
  PayerPlanListResponse,
  RepresentativeDto,
  RepresentativeListResponse,
  RightsRequestDto,
  RightsRequestListResponse,
  type CoverageInput,
  type CreatePatientRequest,
  type CreateRightsRequest,
  type RepresentativeInput,
  type SaveAnamnesisRequest,
  type UpdatePatientRequest,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export type PatientStatusFilter = 'active' | 'inactive' | 'all';

export const patientKeys = {
  all: ['patients'] as const,
  search: (q: string, status: PatientStatusFilter) =>
    ['patients', 'search', { q, status }] as const,
  detail: (id: string) => ['patients', 'detail', id] as const,
  history: (id: string) => ['patients', 'history', id] as const,
  coverages: (id: string) => ['patients', 'coverages', id] as const,
  representatives: (id: string) => ['patients', 'representatives', id] as const,
  consent: (id: string) => ['patients', 'consent', id] as const,
  rights: (id: string) => ['patients', 'rights', id] as const,
  assignments: (id: string) => ['patients', 'assignments', id] as const,
  anamnesis: (id: string) => ['patients', 'anamnesis', id] as const,
  payerPlans: ['patients', 'payer-plans'] as const,
};

/** The patients module of the API. Every call is the organization of the signed-in session. */
export function patientsApi(api: ApiClient) {
  return {
    search: (input: { q: string; status: PatientStatusFilter; cursor?: string | undefined }) =>
      api.get('/patients', {
        query: {
          q: input.q === '' ? undefined : input.q,
          status: input.status,
          cursor: input.cursor,
        },
        schema: PatientSearchResponse,
      }),
    create: (body: CreatePatientRequest) =>
      api.post('/patients', { body, schema: CreatePatientResponse }),
    get: (id: string) => api.get(`/patients/${id}`, { schema: PatientDto }),
    update: (id: string, body: UpdatePatientRequest) =>
      api.patch(`/patients/${id}`, { body, schema: PatientDto }),
    deactivate: (id: string) => api.post(`/patients/${id}/deactivate`, { schema: PatientDto }),
    reactivate: (id: string) => api.post(`/patients/${id}/reactivate`, { schema: PatientDto }),
    history: async (id: string) =>
      (await api.get(`/patients/${id}/history`, { schema: PatientHistoryResponse })).versions,

    coverages: (id: string) =>
      api.get(`/patients/${id}/coverages`, { schema: CoverageListResponse }),
    payerPlans: async () =>
      (await api.get('/payer-plans', { schema: PayerPlanListResponse })).plans,
    addCoverage: (id: string, body: CoverageInput) =>
      api.post(`/patients/${id}/coverages`, { body, schema: CoverageDto }),
    makeCoveragePrimary: (id: string, coverageId: string) =>
      api.patch(`/patients/${id}/coverages/${coverageId}`, {
        body: { primary: true },
        schema: CoverageDto,
      }),
    removeCoverage: (id: string, coverageId: string) =>
      api.delete(`/patients/${id}/coverages/${coverageId}`),

    representatives: (id: string) =>
      api.get(`/patients/${id}/representatives`, { schema: RepresentativeListResponse }),
    addRepresentative: (id: string, body: RepresentativeInput) =>
      api.post(`/patients/${id}/representatives`, { body, schema: RepresentativeDto }),
    removeRepresentative: (id: string, representativeId: string) =>
      api.delete(`/patients/${id}/representatives/${representativeId}`),

    consent: (id: string) => api.get(`/patients/${id}/consent`, { schema: ConsentResponse }),
    recordConsent: (id: string) =>
      api.post(`/patients/${id}/consent`, { schema: ConsentRecordDto }),
    revokeConsent: (id: string) => api.post(`/patients/${id}/consent/revoke`),

    rights: async (id: string) =>
      (await api.get(`/patients/${id}/rights-requests`, { schema: RightsRequestListResponse }))
        .requests,
    createRights: (id: string, body: CreateRightsRequest) =>
      api.post(`/patients/${id}/rights-requests`, { body, schema: RightsRequestDto }),
    /** An access request takes no body; a rectification carries the corrections to apply. */
    fulfillRights: (id: string, requestId: string, changes?: UpdatePatientRequest) =>
      api.post(`/patients/${id}/rights-requests/${requestId}/fulfill`, {
        body: changes ? { changes } : {},
        schema: FulfillRightsResponse,
      }),

    assignments: async (id: string) =>
      (await api.get(`/patients/${id}/assignments`, { schema: AssignmentListResponse }))
        .assignments,
    assign: (id: string, professionalId: string) =>
      api.post(`/patients/${id}/assignments`, { body: { professionalId }, schema: AssignmentDto }),
    unassign: (id: string, professionalId: string) =>
      api.delete(`/patients/${id}/assignments/${professionalId}`),

    anamnesis: (id: string) => api.get(`/patients/${id}/anamnesis`, { schema: AnamnesisResponse }),
    saveAnamnesis: (id: string, body: SaveAnamnesisRequest) =>
      api.put(`/patients/${id}/anamnesis`, { body, schema: AnamnesisVersionDto }),
  };
}
