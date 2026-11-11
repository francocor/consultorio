import {
  DownloadLinkResponse,
  ErxConnectionDto,
  GenericNameSearchResponse,
  PrescriptionCapabilityDto,
  PrescriptionDto,
  PrescriptionListResponse,
  type CancelPrescriptionRequest,
  type CorrectPrescriptionRequest,
  type IssuePrescriptionRequest,
  type PutErxConnectionRequest,
  type RegisterManualPrescriptionRequest,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export const prescriptionKeys = {
  all: ['prescriptions'] as const,
  capability: ['prescriptions', 'capability'] as const,
  mine: ['prescriptions', 'mine'] as const,
  patient: (patientId: string) => ['prescriptions', 'patient', patientId] as const,
  catalog: (query: string) => ['prescriptions', 'catalog', query] as const,
  connection: ['prescriptions', 'connection'] as const,
};

/** What the prescription screens ask of the API. */
export function prescriptionsApi(api: ApiClient) {
  return {
    capability: () => api.get('/prescriptions/capability', { schema: PrescriptionCapabilityDto }),
    mine: () => api.get('/prescriptions', { schema: PrescriptionListResponse }),
    forPatient: (patientId: string) =>
      api.get(`/patients/${patientId}/prescriptions`, { schema: PrescriptionListResponse }),
    catalog: (query: string) =>
      api.get('/prescriptions/catalog', { query: { q: query }, schema: GenericNameSearchResponse }),
    issue: (body: IssuePrescriptionRequest) =>
      api.post('/prescriptions', { body, schema: PrescriptionDto }),
    correct: (id: string, body: CorrectPrescriptionRequest) =>
      api.put(`/prescriptions/${id}`, { body, schema: PrescriptionDto }),
    retry: (id: string) =>
      api.post(`/prescriptions/${id}/retry`, { body: {}, schema: PrescriptionDto }),
    cancel: (id: string, body: CancelPrescriptionRequest) =>
      api.post(`/prescriptions/${id}/cancel`, { body, schema: PrescriptionDto }),
    registerManual: (id: string, body: RegisterManualPrescriptionRequest) =>
      api.post(`/prescriptions/${id}/register-manual`, { body, schema: PrescriptionDto }),
    /** Asks for a link and follows it with this session: the PDF arrives as a blob. */
    downloadPdf: async (id: string) => {
      const link = await api.post(`/prescriptions/${id}/document-link`, {
        body: {},
        schema: DownloadLinkResponse,
      });
      return api.download(link.url);
    },
    connection: () => api.get('/prescriptions/connection', { schema: ErxConnectionDto }),
    saveConnection: (body: PutErxConnectionRequest) =>
      api.put('/prescriptions/connection', { body, schema: ErxConnectionDto }),
  };
}
