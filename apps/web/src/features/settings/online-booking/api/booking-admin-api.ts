import {
  AppointmentTypeListResponse,
  BookingLinkDto,
  BookingLinksResponse,
  StaffListResponse,
  type CreateBookingLinkRequest,
  type UpdateBookingLinkRequest,
} from '@consultorio/contracts';

import { locationsApi } from '../../../../shared/api/locations-api.js';
import type { ApiClient } from '../../../../shared/lib/api-client.js';

export const bookingAdminKeys = {
  links: ['booking-admin', 'links'] as const,
  professionals: ['booking-admin', 'professionals'] as const,
  types: ['booking-admin', 'types'] as const,
  locations: ['booking-admin', 'locations'] as const,
};

/** A professional as the links screen needs them: who they are, nothing about their schedule. */
export interface LinkProfessional {
  id: string;
  name: string;
}

/** What the online-booking screen asks of the API: the links, and the lists they choose from. */
export function bookingAdminApi(api: ApiClient) {
  return {
    links: async () => (await api.get('/booking-links', { schema: BookingLinksResponse })).links,
    create: (body: CreateBookingLinkRequest) =>
      api.post('/booking-links', { body, schema: BookingLinkDto }),
    update: (id: string, body: UpdateBookingLinkRequest) =>
      api.patch(`/booking-links/${id}`, { body, schema: BookingLinkDto }),
    regenerate: (id: string) =>
      api.post(`/booking-links/${id}/regenerate`, { body: {}, schema: BookingLinkDto }),

    /** The active professionals, by the id the links use. */
    professionals: async (): Promise<LinkProfessional[]> =>
      (await api.get('/staff', { schema: StaffListResponse })).staff.flatMap((member) =>
        member.professional?.status === 'active'
          ? [
              {
                id: member.professional.id,
                name:
                  member.displayName ?? member.professional.specialties[0] ?? member.email ?? '',
              },
            ]
          : [],
      ),
    /** The appointment types that can be offered: the active ones. */
    types: async () =>
      (await api.get('/appointment-types', { schema: AppointmentTypeListResponse })).types.filter(
        (type) => type.active,
      ),
    locations: () => locationsApi(api).list(),
  };
}
