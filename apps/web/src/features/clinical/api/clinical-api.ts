import {
  CurrentOdontogramResponse,
  DraftsResponse,
  HistoryResponse,
  NoteDto,
  SearchResponse,
  TemplatesResponse,
  TimelineResponse,
  type AddAddendumRequest,
  type ClinicalSearchQuery,
  type MarkEnteredInErrorRequest,
  type OpenEncounterRequest,
  type SaveDraftRequest,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export const clinicalKeys = {
  all: ['clinical'] as const,
  note: (id: string) => ['clinical', 'note', id] as const,
  history: (id: string) => ['clinical', 'history', id] as const,
  timeline: (patientId: string, includeErrors: boolean) =>
    ['clinical', 'timeline', patientId, { includeErrors }] as const,
  timelineOf: (patientId: string) => ['clinical', 'timeline', patientId] as const,
  search: (patientId: string, query: ClinicalSearchQuery) =>
    ['clinical', 'search', patientId, query] as const,
  odontogram: (patientId: string) => ['clinical', 'odontogram', patientId] as const,
  drafts: ['clinical', 'drafts'] as const,
  templates: ['clinical', 'templates'] as const,
};

/** The clinical module of the API. Every call acts as the signed-in professional. */
export function clinicalApi(api: ApiClient) {
  return {
    templates: () => api.get('/clinical/templates', { schema: TemplatesResponse }),
    open: (body: OpenEncounterRequest) => api.post('/encounters', { body, schema: NoteDto }),
    note: (id: string) => api.get(`/notes/${id}`, { schema: NoteDto }),
    saveDraft: (encounterId: string, body: SaveDraftRequest) =>
      api.put(`/encounters/${encounterId}/note/draft`, { body, schema: NoteDto }),
    sign: (id: string, expectedRevision: number) =>
      api.post(`/notes/${id}/sign`, { body: { expectedRevision }, schema: NoteDto }),
    addAddendum: (id: string, body: AddAddendumRequest) =>
      api.post(`/notes/${id}/addenda`, { body, schema: NoteDto }),
    markError: (id: string, body: MarkEnteredInErrorRequest) =>
      api.post(`/notes/${id}/entered-in-error`, { body, schema: NoteDto }),
    history: (id: string) => api.get(`/notes/${id}/versions`, { schema: HistoryResponse }),
    timeline: (patientId: string, input: { includeErrors: boolean; before?: string | undefined }) =>
      api.get(`/patients/${patientId}/clinical/timeline`, {
        query: {
          includeErrors: input.includeErrors ? 'true' : undefined,
          before: input.before,
        },
        schema: TimelineResponse,
      }),
    search: (patientId: string, query: ClinicalSearchQuery) =>
      api.get(`/patients/${patientId}/clinical/search`, {
        query: { q: query.q, from: query.from, to: query.to },
        schema: SearchResponse,
      }),
    odontogram: (patientId: string) =>
      api.get(`/patients/${patientId}/clinical/odontogram`, { schema: CurrentOdontogramResponse }),
    drafts: () => api.get('/clinical/drafts', { schema: DraftsResponse }),
  };
}
