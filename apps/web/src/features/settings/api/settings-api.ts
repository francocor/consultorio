import { SettingsDto, type UpdateSettingsRequest } from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export const settingsKeys = { all: ['settings'] as const };

/** Organization settings: second-factor policy, what reception sees, sharing, quiet hours. */
export function settingsApi(api: ApiClient) {
  return {
    get: () => api.get('/settings', { schema: SettingsDto }),
    update: (body: UpdateSettingsRequest) => api.patch('/settings', { body, schema: SettingsDto }),
  };
}
