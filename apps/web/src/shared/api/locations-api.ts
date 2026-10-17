import {
  LocationDto,
  LocationListResponse,
  type CreateLocationRequest,
  type UpdateLocationRequest,
} from '@consultorio/contracts';

import type { ApiClient } from '../lib/api-client.js';

export const LOCATIONS_QUERY_KEY = ['locations'] as const;

/** The organization's locations: read by the staff screens and managed in Settings. */
export function locationsApi(api: ApiClient) {
  return {
    list: async (includeInactive = false) =>
      (
        await api.get('/locations', {
          query: { includeInactive: includeInactive ? 'true' : undefined },
          schema: LocationListResponse,
        })
      ).locations,
    create: (body: CreateLocationRequest) => api.post('/locations', { body, schema: LocationDto }),
    update: (id: string, body: UpdateLocationRequest) =>
      api.patch(`/locations/${id}`, { body, schema: LocationDto }),
    deactivate: (id: string) => api.post(`/locations/${id}/deactivate`, { schema: LocationDto }),
    reactivate: (id: string) => api.post(`/locations/${id}/reactivate`, { schema: LocationDto }),
  };
}
