import {
  CheckoutResponse,
  OverageCapResponse,
  PlanImpactResponse,
  PlansResponse,
  RetryPaymentResponse,
  StatementsResponse,
  SubscriptionResponse,
  SubscriptionUsageResponse,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export const subscriptionKeys = {
  all: ['subscription'] as const,
  view: ['subscription', 'view'] as const,
  plans: ['subscription', 'plans'] as const,
  usage: ['subscription', 'usage'] as const,
  statements: ['subscription', 'statements'] as const,
  impact: (professionals: number) => ['subscription', 'impact', professionals] as const,
};

/** The subscription of the organization, for its owner. */
export function subscriptionApi(api: ApiClient) {
  return {
    view: () => api.get('/subscription', { schema: SubscriptionResponse }),
    plans: async () => (await api.get('/subscription/plans', { schema: PlansResponse })).plans,
    usage: () => api.get('/subscription/usage', { schema: SubscriptionUsageResponse }),
    statements: async () =>
      (await api.get('/subscription/statements', { schema: StatementsResponse })).statements,
    impact: (professionals: number) =>
      api.get('/subscription/plan-impact', {
        query: { professionals },
        schema: PlanImpactResponse,
      }),
    checkout: () => api.post('/subscription/checkout', { schema: CheckoutResponse }),
    changePlan: (planKey: string) =>
      api.post('/subscription/plan', { body: { planKey }, schema: SubscriptionResponse }),
    cancel: () => api.post('/subscription/cancel', { schema: SubscriptionResponse }),
    reactivate: () => api.post('/subscription/reactivate', { schema: SubscriptionResponse }),
    retryPayment: () => api.post('/subscription/retry-payment', { schema: RetryPaymentResponse }),
    setOverageCap: (overageCapMessages: number) =>
      api.patch('/subscription/overage-cap', {
        body: { overageCapMessages },
        schema: OverageCapResponse,
      }),
    downloadStatement: (id: string) => api.download(`/subscription/statements/${id}/document`),
  };
}
