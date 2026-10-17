import {
  AppointmentDto,
  AppointmentHistoryResponse,
  AppointmentTypeListResponse,
  AvailabilityResponse,
  CalendarEntryDto,
  CalendarResponse,
  HolidayListResponse,
  SeriesCommitResponse,
  SeriesPreviewResponse,
  StaffListResponse,
  WorklistResponse,
  type BookAppointmentRequest,
  type BookSeriesRequest,
  type CancelAppointmentRequest,
  type CheckInRequest,
  type CorrectStatusRequest,
  type DetachPatientRequest,
  type RescheduleRequest,
  type StaffMemberDto,
} from '@consultorio/contracts';
import { z } from 'zod';

import type { ApiClient } from '../../../shared/lib/api-client.js';

/**
 * The calendar feed. `truncated` says the answer was cut at the server's limit, so the screen asks
 * the person to narrow the filter instead of silently showing a partial day.
 */
export const CalendarFeed = CalendarResponse.extend({ truncated: z.boolean().optional() });
export type CalendarFeed = z.infer<typeof CalendarFeed>;

/** A series answers 200 with a preview or 201 with the created sessions. */
export const SeriesResponse = z.discriminatedUnion('mode', [
  SeriesPreviewResponse,
  SeriesCommitResponse,
]);
export type SeriesResponse = z.infer<typeof SeriesResponse>;

export interface FeedQuery {
  from: string;
  to: string;
  professionalIds: readonly string[];
  locationId: string | undefined;
}

export interface AvailabilityParams {
  professionalId: string;
  typeId: string;
  from: string;
  to: string;
  locationId?: string | undefined;
}

export const calendarKeys = {
  all: ['calendar'] as const,
  feed: (query: FeedQuery) =>
    [
      'calendar',
      'feed',
      query.from,
      query.to,
      [...query.professionalIds].sort().join(','),
      query.locationId ?? '',
    ] as const,
  appointment: (id: string) => ['calendar', 'appointment', id] as const,
  history: (id: string) => ['calendar', 'history', id] as const,
  availability: (params: AvailabilityParams) => ['calendar', 'availability', params] as const,
  types: (includeInactive: boolean) => ['calendar', 'types', { includeInactive }] as const,
  professionals: ['calendar', 'professionals'] as const,
  holidays: (year: number) => ['calendar', 'holidays', year] as const,
  worklistBadge: ['worklist', 'badge'] as const,
};

/**
 * A body that always names the version of the appointment the person was looking at. The API
 * refuses a stale version with 409 `stale_revision`, and (from the next release) requires it.
 */
export type Versioned<T> = T & { expectedVersion: number };

/** The lifecycle words of the URL for the actions that take only a version. */
export type SimpleTransition = 'confirm' | 'start' | 'attend' | 'no-show' | 'approve';

/** Every mutating call carries the version the screen last saw, so a stale screen cannot overwrite. */
export function calendarApi(api: ApiClient) {
  return {
    feed: (query: FeedQuery) =>
      api.get('/appointments', {
        query: {
          from: query.from,
          to: query.to,
          professionalIds:
            query.professionalIds.length > 0 ? query.professionalIds.join(',') : undefined,
          locationId: query.locationId,
        },
        schema: CalendarFeed,
      }),
    get: (id: string) => api.get(`/appointments/${id}`, { schema: CalendarEntryDto }),
    history: (id: string) =>
      api.get(`/appointments/${id}/history`, { schema: AppointmentHistoryResponse }),
    availability: (params: AvailabilityParams) =>
      api.get('/availability', {
        query: { ...params },
        schema: AvailabilityResponse,
      }),
    types: async (includeInactive: boolean) =>
      (
        await api.get('/appointment-types', {
          query: { includeInactive: includeInactive ? 'true' : undefined },
          schema: AppointmentTypeListResponse,
        })
      ).types,
    holidays: async (year: number) =>
      (await api.get('/holidays', { query: { year }, schema: HolidayListResponse })).holidays,
    /** Active professionals of the organization, from the staff directory every role may read. */
    professionals: async (): Promise<StaffMemberDto[]> => {
      const { staff } = await api.get('/staff', { schema: StaffListResponse });
      return staff.filter(
        (member) => member.status === 'active' && member.professional?.status === 'active',
      );
    },

    book: (body: BookAppointmentRequest) =>
      api.post('/appointments', { body, schema: AppointmentDto }),
    transition: (id: string, action: SimpleTransition, expectedVersion: number) =>
      api.post(`/appointments/${id}/${action}`, {
        body: { expectedVersion },
        schema: AppointmentDto,
      }),
    checkIn: (id: string, body: Versioned<CheckInRequest>) =>
      api.post(`/appointments/${id}/check-in`, { body, schema: AppointmentDto }),
    cancel: (id: string, body: Versioned<CancelAppointmentRequest>) =>
      api.post(`/appointments/${id}/cancel`, { body, schema: AppointmentDto }),
    correct: (id: string, body: Versioned<CorrectStatusRequest>) =>
      api.post(`/appointments/${id}/correct`, { body, schema: AppointmentDto }),
    reschedule: (id: string, body: RescheduleRequest) =>
      api.post(`/appointments/${id}/reschedule`, { body, schema: AppointmentDto }),
    detachPatient: (id: string, body: Versioned<DetachPatientRequest>) =>
      api.post(`/appointments/${id}/detach-patient`, { body, schema: AppointmentDto }),
    series: (body: BookSeriesRequest) =>
      api.post('/appointments/series', { body, schema: SeriesResponse }),

    worklistOpenCount: async () =>
      (
        await api.get('/worklist', {
          query: { status: 'open', limit: 1 },
          schema: WorklistResponse,
        })
      ).openCount,
  };
}
