import {
  WaitlistCallListResponse,
  WaitlistEntryDetailResponse,
  WaitlistEntryDto,
  WaitlistListResponse,
  type CloseWaitlistEntryRequest,
  type CreateWaitlistEntryRequest,
  type SetWaitlistPriorityRequest,
  type UpdateWaitlistEntryRequest,
  type WaitlistEntryStatus,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export interface WaitlistFilters {
  /** Absent: the entries still in play. */
  status?: WaitlistEntryStatus | undefined;
  patientId?: string | undefined;
  appointmentTypeId?: string | undefined;
  professionalId?: string | undefined;
  unresponsive?: boolean | undefined;
}

export const waitlistKeys = {
  all: ['waitlist'] as const,
  list: (filters: WaitlistFilters) => ['waitlist', 'list', filters] as const,
  calls: ['waitlist', 'calls'] as const,
  entry: (id: string) => ['waitlist', 'entry', id] as const,
};

/** What the waitlist screens ask of the API. */
export function waitlistApi(api: ApiClient) {
  return {
    list: (filters: WaitlistFilters = {}) =>
      api.get('/waitlist', {
        query: { ...filters, unresponsive: filters.unresponsive ? true : undefined },
        schema: WaitlistListResponse,
      }),
    calls: () => api.get('/waitlist/to-call', { schema: WaitlistCallListResponse }),
    detail: (id: string) => api.get(`/waitlist/${id}`, { schema: WaitlistEntryDetailResponse }),
    create: (body: CreateWaitlistEntryRequest) =>
      api.post('/waitlist', { body, schema: WaitlistEntryDto }),
    update: (id: string, body: UpdateWaitlistEntryRequest) =>
      api.patch(`/waitlist/${id}`, { body, schema: WaitlistEntryDto }),
    pause: (id: string) =>
      api.post(`/waitlist/${id}/pause`, { body: {}, schema: WaitlistEntryDto }),
    resume: (id: string) =>
      api.post(`/waitlist/${id}/resume`, { body: {}, schema: WaitlistEntryDto }),
    close: (id: string, body: CloseWaitlistEntryRequest) =>
      api.post(`/waitlist/${id}/close`, { body, schema: WaitlistEntryDto }),
    priority: (id: string, body: SetWaitlistPriorityRequest) =>
      api.post(`/waitlist/${id}/priority`, { body, schema: WaitlistEntryDto }),
  };
}
