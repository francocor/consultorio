import {
  PaymentsSimulatorCycleRequest,
  PaymentsSimulatorCycleResponse,
  PaymentsSimulatorModeRequest,
  PaymentsSimulatorStateResponse,
  type PaymentsSimulatorStateResponse as State,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { deliver, paymentNotices } from './notices.js';

import type { LocalPaymentsControls, LocalPaymentsGateway } from './index.js';

/**
 * The controls of the local Mercado Pago (`/operator/dev/payments/*`, provider console): see what the
 * simulator holds, put it in a mode (an outage, a lost answer, a refused amount change, notices that
 * arrive twice or backwards), run the billing cycle and reset it. They exist only while
 * `LOCAL_PROVIDERS_CONSOLE=true` and live inside the operator console, so they answer only on the
 * platform host behind the operator session.
 *
 * "Run the billing cycle" charges every authorized preapproval now, approved or rejected, and posts
 * the notices of those payments, signed with the webhook secret, to the real webhook of the
 * application: the path a real provider takes is the path the simulation takes.
 */

const SHOWN = 100;

export interface PaymentsDevRoutesDeps {
  controls: LocalPaymentsControls;
  gateway: Pick<LocalPaymentsGateway, 'sign'>;
}

export function paymentsDevRoutes(deps: PaymentsDevRoutesDeps) {
  const { controls, gateway } = deps;

  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    const base = '/operator/dev/payments';
    const read = { readOnly: 'read', auth: 'public', operatorAuth: 'session' } as const;
    const write = {
      readOnly: 'write',
      auth: 'public',
      operatorAuth: 'session',
      audits: 'none',
    } as const;

    async function state(): Promise<State> {
      const [preapprovals, payments] = await Promise.all([
        controls.preapprovals(SHOWN),
        controls.payments(SHOWN),
      ]);
      return {
        mode: await controls.mode(),
        preapprovals: preapprovals.map((entry) => ({
          ...entry,
          createdAt: entry.createdAt.toISOString(),
        })),
        payments: payments.map((entry) => ({ ...entry, createdAt: entry.createdAt.toISOString() })),
      };
    }

    typed.get(
      `${base}/state`,
      { config: read, schema: { response: { 200: PaymentsSimulatorStateResponse } } },
      state,
    );

    typed.put(
      `${base}/mode`,
      {
        config: write,
        schema: {
          body: PaymentsSimulatorModeRequest,
          response: { 200: PaymentsSimulatorModeRequest },
        },
      },
      async (request) => {
        await controls.setMode(request.body.mode);
        return { mode: request.body.mode };
      },
    );

    typed.post(
      `${base}/cycle`,
      {
        config: write,
        schema: {
          body: PaymentsSimulatorCycleRequest,
          response: { 200: PaymentsSimulatorCycleResponse },
        },
      },
      async (request) => {
        const paymentIds = await controls.runBillingCycle(request.body.outcome);
        const mode = await controls.mode();
        let delivered = 0;
        for (const paymentId of paymentIds) {
          delivered += await deliver(request.server, gateway, mode, paymentNotices(paymentId));
        }
        return { charged: paymentIds.length, delivered };
      },
    );

    typed.post(
      `${base}/reset`,
      {
        config: write,
        schema: {
          body: z.strictObject({}).optional(),
          response: { 200: PaymentsSimulatorStateResponse },
        },
      },
      async () => {
        await controls.reset();
        return state();
      },
    );
  };
}
