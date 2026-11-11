import {
  AppointmentTypeDto,
  BlockListResponse,
  DayOffDto,
  HolidayListResponse,
  type CreateAppointmentTypeRequest,
  type CreateBlockRequest,
  type CreateDayOffRequest,
  type UpdateAppointmentTypeRequest,
} from '@consultorio/contracts';
import { z } from 'zod';

import type { ApiClient } from '../../../../shared/lib/api-client.js';
import { calendarApi } from '../../../calendar/api/calendar-api.js';

export const schedulingSettingsKeys = {
  all: ['scheduling-settings'] as const,
  types: (includeInactive: boolean) =>
    ['scheduling-settings', 'types', { includeInactive }] as const,
  blocks: (from: string) => ['scheduling-settings', 'blocks', from] as const,
  holidays: (year: number) => ['scheduling-settings', 'holidays', year] as const,
};

const CreatedBlocks = z.strictObject({ blocks: BlockListResponse.shape.blocks });

/** Setup of the agenda: what can be booked, when it is closed, and who may be overbooked. */
export function schedulingSettingsApi(api: ApiClient) {
  return {
    types: (includeInactive: boolean) => calendarApi(api).types(includeInactive),
    createType: (body: CreateAppointmentTypeRequest) =>
      api.post('/appointment-types', { body, schema: AppointmentTypeDto }),
    updateType: (id: string, body: UpdateAppointmentTypeRequest) =>
      api.patch(`/appointment-types/${id}`, { body, schema: AppointmentTypeDto }),
    setTypeActive: (id: string, active: boolean) =>
      api.post(`/appointment-types/${id}/${active ? 'reactivate' : 'deactivate'}`, {
        schema: AppointmentTypeDto,
      }),

    /** The blocks that end after `from`. */
    blocks: async (from: string) =>
      (await api.get('/schedule-blocks', { query: { from }, schema: BlockListResponse })).blocks,
    createBlock: async (body: CreateBlockRequest) =>
      (await api.post('/schedule-blocks', { body, schema: CreatedBlocks })).blocks,
    removeBlock: (id: string, scope: 'occurrence' | 'series') =>
      api.delete(`/schedule-blocks/${id}`, { query: { scope } }),

    /** The country holidays and the organization's days off of one year, merged. */
    holidays: async (year: number) =>
      (await api.get('/holidays', { query: { year }, schema: HolidayListResponse })).holidays,
    createDayOff: (body: CreateDayOffRequest) => api.post('/days-off', { body, schema: DayOffDto }),
    removeDayOff: (id: string) => api.delete(`/days-off/${id}`),
  };
}
