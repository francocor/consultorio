import {
  CreateTenantResponse,
  OperatorHolidayDto,
  OperatorHolidayListResponse,
  DemoResetResponse,
  OperatorDto,
  OperatorTenantListResponse,
  ResendOwnerInvitationResponse,
  type AddHolidayRequest,
  type CreateTenantRequest,
  type OperatorLoginRequest,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export const operatorKeys = {
  me: ['operator', 'me'] as const,
  tenants: ['operator', 'tenants'] as const,
  holidaysAll: ['operator', 'holidays'] as const,
  holidays: (country: string, year: number) => ['operator', 'holidays', country, year] as const,
};

/** The platform operator API. Only the platform host answers it. */
export function operatorApi(api: ApiClient) {
  return {
    login: (body: OperatorLoginRequest) =>
      api.post('/operator/auth/login', { body, schema: OperatorDto }),
    logout: () => api.post('/operator/auth/logout'),
    me: () => api.get('/operator/me', { schema: OperatorDto }),
    tenants: async () =>
      (await api.get('/operator/tenants', { schema: OperatorTenantListResponse })).tenants,
    createTenant: (body: CreateTenantRequest) =>
      api.post('/operator/tenants', { body, schema: CreateTenantResponse }),
    resendInvitation: (tenantId: string, ownerEmail: string) =>
      api.post(`/operator/tenants/${tenantId}/owner-invitation`, {
        body: { ownerEmail },
        schema: ResendOwnerInvitationResponse,
      }),
    holidays: async (country: string, year: number) =>
      (
        await api.get('/operator/holidays', {
          query: { country, year },
          schema: OperatorHolidayListResponse,
        })
      ).holidays,
    addHoliday: (body: AddHolidayRequest) =>
      api.post('/operator/holidays', { body, schema: OperatorHolidayDto }),
    removeHoliday: (id: string) => api.delete(`/operator/holidays/${id}`),
    demoReset: (tenantId: string) =>
      api.post(`/operator/tenants/${tenantId}/demo-reset`, { schema: DemoResetResponse }),
  };
}
