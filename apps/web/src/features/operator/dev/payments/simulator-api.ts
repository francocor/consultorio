import {
  PaymentsSimulatorCycleResponse,
  PaymentsSimulatorModeRequest,
  PaymentsSimulatorStateResponse,
  type PaymentsSimulatorMode,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../../shared/lib/api-client.js';

export const paymentsSimulatorKeys = { state: ['operator', 'dev', 'payments'] as const };

const BASE = '/operator/dev/payments';

/** The controls of the local Mercado Pago (only deployments with the provider console have them). */
export function paymentsSimulatorApi(api: ApiClient) {
  return {
    state: () => api.get(`${BASE}/state`, { schema: PaymentsSimulatorStateResponse }),
    setMode: (mode: PaymentsSimulatorMode) =>
      api.put(`${BASE}/mode`, { body: { mode }, schema: PaymentsSimulatorModeRequest }),
    runCycle: (outcome: 'approved' | 'rejected') =>
      api.post(`${BASE}/cycle`, { body: { outcome }, schema: PaymentsSimulatorCycleResponse }),
    reset: () => api.post(`${BASE}/reset`, { body: {}, schema: PaymentsSimulatorStateResponse }),
  };
}
