import {
  ErxSimulatorAdvanceResponse,
  ErxSimulatorModeRequest,
  ErxSimulatorStateResponse,
  type ErxSimulatorMode,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../../shared/lib/api-client.js';

export const erxSimulatorKeys = { state: ['operator', 'dev', 'erx'] as const };

const BASE = '/operator/dev/erx';

/** The controls of the local e-prescription simulator (only deployments with the provider console have them). */
export function erxSimulatorApi(api: ApiClient) {
  return {
    state: () => api.get(`${BASE}/state`, { schema: ErxSimulatorStateResponse }),
    setMode: (mode: ErxSimulatorMode) =>
      api.put(`${BASE}/mode`, { body: { mode }, schema: ErxSimulatorModeRequest }),
    advance: (externalId: string, to: 'dispensed' | 'expired') =>
      api.post(`${BASE}/advance`, {
        body: { externalId, to },
        schema: ErxSimulatorAdvanceResponse,
      }),
    reset: () => api.post(`${BASE}/reset`, { body: {}, schema: ErxSimulatorStateResponse }),
  };
}
