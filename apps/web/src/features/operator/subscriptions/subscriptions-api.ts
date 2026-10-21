import {
  OperatorPaymentsResponse,
  OperatorRefundResponse,
  OperatorResolveParkedResponse,
  OperatorSubscriptionsResponse,
  OperatorSurplusReviewResponse,
  OperatorUsageResponse,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export const operatorSubscriptionKeys = {
  list: ['operator', 'subscriptions'] as const,
  usage: (tenantId: string) => ['operator', 'subscriptions', 'usage', tenantId] as const,
  payments: (tenantId: string) => ['operator', 'subscriptions', 'payments', tenantId] as const,
};

/** The support view of the subscriptions: state, dates and counts. Nothing about a person. */
export function operatorSubscriptionsApi(api: ApiClient) {
  return {
    list: async () =>
      (await api.get('/operator/subscriptions', { schema: OperatorSubscriptionsResponse }))
        .subscriptions,
    usage: (tenantId: string) =>
      api.get('/operator/usage', { query: { tenantId }, schema: OperatorUsageResponse }),
    /** The payments of one organization: amounts, states and flags, never a payer. */
    payments: async (tenantId: string) =>
      (
        await api.get(`/operator/tenants/${tenantId}/subscription/payments`, {
          schema: OperatorPaymentsResponse,
        })
      ).payments,
    /** Lets a parked subscription go; the reason goes into the trail with the operator. */
    resolveParked: (tenantId: string, reason: string) =>
      api.post(`/operator/tenants/${tenantId}/subscription/resolve-parked`, {
        body: { reason },
        schema: OperatorResolveParkedResponse,
      }),
    /** Refunds a payment. The token belongs to THIS request: a retry or a double click sends the same one. */
    refund: (
      tenantId: string,
      paymentId: string,
      body: { amountCents: number; reason: string; token: string },
    ) =>
      api.post(`/operator/tenants/${tenantId}/subscription/payments/${paymentId}/refund`, {
        body: { ...body, confirmed: true },
        schema: OperatorRefundResponse,
      }),
    review: (tenantId: string, paymentId: string, reason: string) =>
      api.post(`/operator/tenants/${tenantId}/subscription/payments/${paymentId}/review`, {
        body: { reason },
        schema: OperatorSurplusReviewResponse,
      }),
  };
}
