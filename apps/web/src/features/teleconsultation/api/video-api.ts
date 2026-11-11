import {
  SettingsDto,
  VideoJoinResponse,
  VideoSessionSummary,
  type UpdateSettingsRequest,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export const videoKeys = {
  all: ['teleconsultation'] as const,
  /** The version is part of the key: a move of the appointment asks for the summary again. */
  summary: (appointmentId: string, version: number) =>
    ['teleconsultation', 'summary', appointmentId, version] as const,
};

/** The video side of an appointment: what it is, whether it has a link, and the actions on it. */
export function videoApi(api: ApiClient) {
  return {
    summary: (appointmentId: string) =>
      api.get(`/appointments/${appointmentId}/video`, { schema: VideoSessionSummary }),
    /** The address of the call. The caller opens it; it is not kept anywhere. */
    join: (appointmentId: string) =>
      api.post(`/appointments/${appointmentId}/video/join`, {
        body: {},
        schema: VideoJoinResponse,
      }),
    attachManualLink: (appointmentId: string, url: string) =>
      api.put(`/appointments/${appointmentId}/video/manual-link`, {
        body: { url },
        schema: VideoSessionSummary,
      }),
  };
}

/** The same cache key the Settings screens use, so a change here shows there. */
export const settingsKey = ['settings'] as const;

/** The organization settings, of which this feature reads and writes two sections. */
export function videoSettingsApi(api: ApiClient) {
  return {
    get: () => api.get('/settings', { schema: SettingsDto }),
    update: (body: UpdateSettingsRequest) => api.patch('/settings', { body, schema: SettingsDto }),
  };
}
