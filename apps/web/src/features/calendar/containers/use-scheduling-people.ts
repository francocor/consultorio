import type { LocationDto, StaffMemberDto } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useApi } from '../../../app/providers.js';
import { useMe } from '../../../app/session.js';
import { locationsApi, LOCATIONS_QUERY_KEY } from '../../../shared/api/locations-api.js';
import { calendarApi, calendarKeys } from '../api/calendar-api.js';

export interface SchedulingProfessional {
  /** The professional id the scheduling API uses (not the membership id). */
  id: string;
  membershipId: string;
  name: string;
  specialties: string[];
  locationIds: string[];
}

export function toSchedulingProfessional(member: StaffMemberDto): SchedulingProfessional | null {
  if (!member.professional) return null;
  return {
    id: member.professional.id,
    membershipId: member.membershipId,
    name: member.displayName ?? member.professional.specialties[0] ?? member.membershipId,
    specialties: member.professional.specialties,
    locationIds: member.locations.map((location) => location.id),
  };
}

/** The active professionals, and which of them is the signed-in person (if any). */
export function useSchedulingProfessionals() {
  const api = useApi();
  const me = useMe();
  const query = useQuery({
    queryKey: calendarKeys.professionals,
    queryFn: () => calendarApi(api).professionals(),
    staleTime: 5 * 60_000,
  });

  return useMemo(() => {
    const members = query.data ?? [];
    const professionals = members.flatMap((member) => toSchedulingProfessional(member) ?? []);
    // The directory shows a person their own email, so that is how the screen knows who is "me".
    const mine = members.find(
      (member) =>
        member.professional !== null &&
        member.email !== null &&
        member.email.toLowerCase() === me.user.email.toLowerCase(),
    );
    return {
      query,
      professionals,
      ownProfessionalId: mine?.professional?.id ?? null,
    };
  }, [query, me.user.email]);
}

/** The active locations of the organization. */
export function useSchedulingLocations() {
  const api = useApi();
  const query = useQuery({
    queryKey: [...LOCATIONS_QUERY_KEY, { showInactive: false }],
    queryFn: () => locationsApi(api).list(false),
    staleTime: 5 * 60_000,
  });
  const locations: LocationDto[] = query.data ?? [];
  return { query, locations };
}
