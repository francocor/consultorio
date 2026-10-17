import {
  AppointmentDto,
  WorklistItemDto,
  WorklistResponse,
  type DetachPatientRequest,
  type WorklistKind,
  type WorklistStatus,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

/** The most items one answer carries (the API caps it); a reception desk never has this many open. */
export const WORKLIST_LIMIT = 200;

export const worklistKeys = {
  all: ['worklist'] as const,
  list: (status: WorklistStatus, kind: WorklistKind | undefined) =>
    ['worklist', 'list', status, kind ?? ''] as const,
  badge: ['worklist', 'badge'] as const,
};

/** The reception worklist: everything that needs a person, from every capability. */
export function worklistApi(api: ApiClient) {
  return {
    list: (status: WorklistStatus, kind?: WorklistKind) =>
      api.get('/worklist', {
        query: { status, kind, limit: WORKLIST_LIMIT },
        schema: WorklistResponse,
      }),
    /** The number on the navigation badge: open items the person can see. */
    openCount: async () =>
      (
        await api.get('/worklist', {
          query: { status: 'open', limit: 1 },
          schema: WorklistResponse,
        })
      ).openCount,
    resolve: (id: string) =>
      api.post(`/worklist/${id}/resolve`, { body: {}, schema: WorklistItemDto }),
    dismiss: (id: string) =>
      api.post(`/worklist/${id}/dismiss`, { body: {}, schema: WorklistItemDto }),
    /** Confirms the identity of the appointment the item is about, against its current version. */
    confirmIdentity: (id: string, expectedVersion: number) =>
      api.post(`/worklist/${id}/confirm-identity`, {
        body: { expectedVersion },
        schema: AppointmentDto,
      }),
    /** The match was wrong: move the appointment to another record, or cancel it. */
    detachPatient: (appointmentId: string, body: DetachPatientRequest) =>
      api.post(`/appointments/${appointmentId}/detach-patient`, { body, schema: AppointmentDto }),
  };
}
