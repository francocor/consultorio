import {
  AppointmentTypeListResponse,
  StaffListResponse,
  type AppointmentTypeDto,
  type LocationDto,
} from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';

import { useApi } from '../../../app/providers.js';
import { locationsApi, LOCATIONS_QUERY_KEY } from '../../../shared/api/locations-api.js';

export interface ProfessionalOption {
  /** The id of the professional profile (what an entry names). */
  id: string;
  name: string;
}

/**
 * What a person can choose an entry to wait for: the types on offer, the professionals who work
 * and the places that are open. Read from the same directories the calendar reads.
 */
export function useWaitlistOptions(): {
  types: AppointmentTypeDto[];
  professionals: ProfessionalOption[];
  locations: LocationDto[];
  ready: boolean;
} {
  const api = useApi();
  const types = useQuery({
    queryKey: ['waitlist', 'types'],
    queryFn: async () =>
      (await api.get('/appointment-types', { schema: AppointmentTypeListResponse })).types,
    staleTime: 60_000,
  });
  const staff = useQuery({
    queryKey: ['waitlist', 'professionals'],
    queryFn: async () => (await api.get('/staff', { schema: StaffListResponse })).staff,
    staleTime: 60_000,
  });
  const locations = useQuery({
    queryKey: [...LOCATIONS_QUERY_KEY, 'waitlist'],
    queryFn: () => locationsApi(api).list(),
    staleTime: 60_000,
  });

  const professionals: ProfessionalOption[] = (staff.data ?? [])
    .filter((member) => member.status === 'active' && member.professional?.status === 'active')
    .flatMap((member) =>
      member.professional
        ? [{ id: member.professional.id, name: member.displayName?.trim() || '—' }]
        : [],
    );
  return {
    types: (types.data ?? []).filter((type) => type.active),
    professionals,
    locations: (locations.data ?? []).filter((place) => place.active),
    ready: types.isSuccess && staff.isSuccess && locations.isSuccess,
  };
}
