import { OperatorSubscriptionsResponse, OperatorUsageResponse } from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export const operatorSubscriptionKeys = {
  list: ['operator', 'subscriptions'] as const,
  usage: (tenantId: string) => ['operator', 'subscriptions', 'usage', tenantId] as const,
};

/** The support view of the subscriptions: state, dates and counts. Nothing about a person. */
export function operatorSubscriptionsApi(api: ApiClient) {
  return {
    list: async () =>
      (await api.get('/operator/subscriptions', { schema: OperatorSubscriptionsResponse }))
        .subscriptions,
    usage: (tenantId: string) =>
      api.get('/operator/usage', { query: { tenantId }, schema: OperatorUsageResponse }),
  };
}
