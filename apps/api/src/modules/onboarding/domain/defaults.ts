import type { CreateAppointmentTypeRequest, WeeklyInterval } from '@consultorio/contracts';

/**
 * The sensible defaults of the solo fast path (tenant-onboarding, "Fast path for solo
 * professionals"). They are data the organization owns from the moment they are created and can
 * edit afterwards; they are written in the language of the market the product serves first
 * (es-AR), like the names an owner would type.
 */
export const DEFAULT_LOCATION_NAME = 'Consultorio';

/** Monday to Friday, 09:00 to 17:00, at the given location. */
export function defaultWeeklyHours(locationId: string): WeeklyInterval[] {
  return [1, 2, 3, 4, 5].map((weekday) => ({
    locationId,
    weekday,
    start: '09:00',
    end: '17:00',
  }));
}

/** A 30-minute in-person consultation anyone in the organization can offer. */
export const DEFAULT_APPOINTMENT_TYPE: CreateAppointmentTypeRequest = {
  name: 'Consulta',
  description: null,
  durationMinutes: 30,
  bufferMinutes: 0,
  mode: 'in_person',
  priceReference: null,
  requiresApproval: false,
  color: null,
  professionalIds: [],
  specialties: [],
};
