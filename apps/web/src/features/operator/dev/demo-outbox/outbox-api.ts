import { DemoOutboxResponse } from '@consultorio/contracts';

import type { ApiClient } from '../../../../shared/lib/api-client.js';

export const demoOutboxKeys = {
  list: (to: string) => ['operator', 'dev', 'demo-outbox', to] as const,
};

/** What the demo organizations "sent", newest first (only deployments with the provider console have it). */
export function demoOutboxApi(api: ApiClient) {
  return {
    list: (to: string) =>
      api.get('/operator/dev/demo-outbox', {
        ...(to === '' ? {} : { query: { to } }),
        schema: DemoOutboxResponse,
      }),
  };
}
