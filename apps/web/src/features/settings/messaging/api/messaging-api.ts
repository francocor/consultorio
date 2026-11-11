import {
  AppointmentMessagesResponse,
  PatientChannelsResponse,
  UsageResponse,
  type MessageChannel,
} from '@consultorio/contracts';
import { z } from 'zod';

import type { ApiClient } from '../../../../shared/lib/api-client.js';

export const messagingKeys = {
  usage: ['messaging', 'usage'] as const,
  messages: (appointmentId: string) => ['messaging', 'messages', appointmentId] as const,
  channels: (patientId: string) => ['messaging', 'channels', patientId] as const,
};

const OptInRequestSent = z.strictObject({ sent: z.literal(true) });

/** What the messaging screens ask of the API: usage, the log of an appointment, a patient's channels. */
export function messagingApi(api: ApiClient) {
  return {
    usage: () => api.get('/notifications/usage', { schema: UsageResponse }),
    messages: (appointmentId: string) =>
      api.get(`/appointments/${appointmentId}/messages`, { schema: AppointmentMessagesResponse }),
    resend: (appointmentId: string, channel: MessageChannel) =>
      api.post(`/appointments/${appointmentId}/messages/resend`, {
        body: { channel },
        schema: AppointmentMessagesResponse,
      }),
    channels: (patientId: string) =>
      api.get(`/patients/${patientId}/channels`, { schema: PatientChannelsResponse }),
    optIn: (patientId: string, channel: MessageChannel) =>
      api.post(`/patients/${patientId}/channels/${channel}/opt-in`, {
        body: {},
        schema: PatientChannelsResponse,
      }),
    /** A baja is for every channel (owner decision B7). */
    optOut: (patientId: string) =>
      api.post(`/patients/${patientId}/opt-out`, {
        body: {},
        schema: PatientChannelsResponse,
      }),
    requestOptIn: (patientId: string) =>
      api.post(`/patients/${patientId}/whatsapp-opt-in-request`, {
        body: {},
        schema: OptInRequestSent,
      }),
  };
}
