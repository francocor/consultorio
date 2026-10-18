import {
  AfipSimulatorModeRequest,
  AfipSimulatorStateResponse,
  type AfipSimulatorStateResponse as State,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { LocalAfipControls } from './index.js';

/**
 * The controls of the local AFIP simulator (`/operator/dev/afip/*`, provider console): see the
 * vouchers it issued, put it in a mode (outage, slow, timeout after authorizing, reject the next
 * request) and reset it. They exist only while `LOCAL_PROVIDERS_CONSOLE=true` and live inside the
 * operator console, so they answer only on the platform host behind the operator session.
 */

const VOUCHERS_SHOWN = 100;

export interface AfipDevRoutesDeps {
  controls: LocalAfipControls;
}

export function afipDevRoutes(deps: AfipDevRoutesDeps) {
  const { controls } = deps;

  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    const base = '/operator/dev/afip';
    const read = { readOnly: 'read', auth: 'public', operatorAuth: 'session' } as const;
    const write = {
      readOnly: 'write',
      auth: 'public',
      operatorAuth: 'session',
      audits: 'none',
    } as const;

    async function state(): Promise<State> {
      const vouchers = await controls.vouchers(VOUCHERS_SHOWN);
      return {
        mode: await controls.mode(),
        vouchers: vouchers.map((voucher) => ({
          ...voucher,
          createdAt: voucher.createdAt.toISOString(),
        })),
      };
    }

    typed.get(
      `${base}/state`,
      { config: read, schema: { response: { 200: AfipSimulatorStateResponse } } },
      state,
    );

    typed.put(
      `${base}/mode`,
      {
        config: write,
        schema: { body: AfipSimulatorModeRequest, response: { 200: AfipSimulatorModeRequest } },
      },
      async (request) => {
        await controls.setMode(request.body.mode);
        return { mode: request.body.mode };
      },
    );

    typed.post(
      `${base}/reset`,
      {
        config: write,
        schema: {
          body: z.strictObject({}).optional(),
          response: { 200: AfipSimulatorStateResponse },
        },
      },
      async () => {
        await controls.reset();
        return state();
      },
    );
  };
}
