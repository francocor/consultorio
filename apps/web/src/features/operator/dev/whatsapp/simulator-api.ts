import {
  SimulatorEventResponse,
  SimulatorModeRequest,
  SimulatorStateResponse,
  SimulatorUnreachableRequest,
  type SimulatorStatusRequest,
  type WhatsAppSimulatorMode,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../../shared/lib/api-client.js';

export const simulatorKeys = { state: ['operator', 'dev', 'whatsapp'] as const };

const BASE = '/operator/dev/whatsapp';

/** The controls of the local WhatsApp simulator (only deployments with the provider console have them). */
export function simulatorApi(api: ApiClient) {
  return {
    state: () => api.get(`${BASE}/messages`, { schema: SimulatorStateResponse }),
    setStatus: (providerMessageId: string, body: SimulatorStatusRequest) =>
      api.post(`${BASE}/messages/${encodeURIComponent(providerMessageId)}/status`, {
        body,
        schema: SimulatorEventResponse,
      }),
    reply: (from: string, text: string) =>
      api.post(`${BASE}/inbound`, { body: { from, text }, schema: SimulatorEventResponse }),
    setMode: (mode: WhatsAppSimulatorMode) =>
      api.put(`${BASE}/mode`, { body: { mode }, schema: SimulatorModeRequest }),
    setUnreachable: (number: string, unreachable: boolean) =>
      api.put(`${BASE}/unreachable`, {
        body: { number, unreachable },
        schema: SimulatorUnreachableRequest,
      }),
  };
}
