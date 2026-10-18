import {
  AfipSimulatorModeRequest,
  AfipSimulatorStateResponse,
  type AfipSimulatorMode,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../../shared/lib/api-client.js';

export const afipSimulatorKeys = { state: ['operator', 'dev', 'afip'] as const };

const BASE = '/operator/dev/afip';

/** The controls of the local AFIP simulator (only deployments with the provider console have them). */
export function afipSimulatorApi(api: ApiClient) {
  return {
    state: () => api.get(`${BASE}/state`, { schema: AfipSimulatorStateResponse }),
    setMode: (mode: AfipSimulatorMode) =>
      api.put(`${BASE}/mode`, { body: { mode }, schema: AfipSimulatorModeRequest }),
    reset: () => api.post(`${BASE}/reset`, { body: {}, schema: AfipSimulatorStateResponse }),
  };
}
