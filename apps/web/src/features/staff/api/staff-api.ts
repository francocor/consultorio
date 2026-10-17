import {
  GrantListResponse,
  InviteStaffResponse,
  MemberLocationsResponse,
  MemberRolesResponse,
  ProfessionalDto,
  StaffListResponse,
  StaffStatusResponse,
  WeeklyHoursResponse,
  type GrantScope,
  type InviteStaffRequest,
  type ProfessionalProfileRequest,
  type StaffRole,
  type WeeklyInterval,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export const staffKeys = {
  all: ['staff'] as const,
  list: (includeDeactivated: boolean) => ['staff', 'list', { includeDeactivated }] as const,
  profile: (membershipId: string) => ['staff', 'profile', membershipId] as const,
  grants: (membershipId: string) => ['staff', 'grants', membershipId] as const,
  locations: (membershipId: string) => ['staff', 'locations', membershipId] as const,
  hours: (professionalId: string) => ['staff', 'hours', professionalId] as const,
};

/** The staff module of the API: directory, invitations, roles, profile, grants, locations, hours. */
export function staffApi(api: ApiClient) {
  return {
    list: async (includeDeactivated: boolean) =>
      (
        await api.get('/staff', {
          query: { includeDeactivated: includeDeactivated ? 'true' : undefined },
          schema: StaffListResponse,
        })
      ).staff,
    invite: (body: InviteStaffRequest) =>
      api.post('/staff/invitations', { body, schema: InviteStaffResponse }),
    changeRoles: (membershipId: string, roles: StaffRole[]) =>
      api.put(`/members/${membershipId}/roles`, { body: { roles }, schema: MemberRolesResponse }),
    deactivate: (membershipId: string) =>
      api.post(`/staff/${membershipId}/deactivate`, { schema: StaffStatusResponse }),
    reactivate: (membershipId: string) =>
      api.post(`/staff/${membershipId}/reactivate`, { schema: StaffStatusResponse }),
    profile: (membershipId: string) =>
      api.get(`/staff/${membershipId}/professional-profile`, { schema: ProfessionalDto }),
    saveProfile: (membershipId: string, body: ProfessionalProfileRequest) =>
      api.put(`/staff/${membershipId}/professional-profile`, { body, schema: ProfessionalDto }),
    grants: (membershipId: string) =>
      api.get(`/members/${membershipId}/grants`, { schema: GrantListResponse }),
    grant: (membershipId: string, permission: string, scope?: GrantScope) =>
      api.post(`/members/${membershipId}/grants`, {
        body: scope ? { permission, scope } : { permission },
      }),
    revoke: (membershipId: string, permission: string) =>
      api.delete(`/members/${membershipId}/grants/${permission}`),
    memberLocations: (membershipId: string) =>
      api.get(`/members/${membershipId}/locations`, { schema: MemberLocationsResponse }),
    setMemberLocations: (membershipId: string, locationIds: string[]) =>
      api.put(`/members/${membershipId}/locations`, {
        body: { locationIds },
        schema: MemberLocationsResponse,
      }),
    hours: (professionalId: string) =>
      api.get(`/professionals/${professionalId}/hours`, { schema: WeeklyHoursResponse }),
    setHours: (professionalId: string, hours: WeeklyInterval[]) =>
      api.put(`/professionals/${professionalId}/hours`, {
        body: { hours },
        schema: WeeklyHoursResponse,
      }),
  };
}
