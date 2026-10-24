import { randomUUID } from 'node:crypto';

import {
  ErxSimulatorAdvanceRequest,
  ErxSimulatorAdvanceResponse,
  ErxSimulatorModeRequest,
  ErxSimulatorStateResponse,
  type ErxSimulatorStateResponse as State,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { AppError } from '../../platform/http/problem.js';

import type { LocalErxControls, LocalPrescriptionProvider } from './index.js';

/**
 * The controls of the local e-prescription simulator (`/operator/dev/erx/*`, provider console): see
 * the prescriptions it issued, put it in a mode (outage, answer lost after issuing), move a
 * prescription to dispensed or expired, and reset it. They exist only while
 * `LOCAL_PROVIDERS_CONSOLE=true` and live inside the operator console, so they answer only on the
 * platform host behind the operator session.
 *
 * A change of state is SIGNED here with the webhook secret and POSTED to the application's own
 * webhook, so the path a real provider takes (signature check, lookup of the organization by the
 * identifier, queued reconciliation) is the path the simulation takes.
 */

const PRESCRIPTIONS_SHOWN = 100;

export interface ErxDevRoutesDeps {
  controls: LocalErxControls;
  provider: LocalPrescriptionProvider;
}

export function erxDevRoutes(deps: ErxDevRoutesDeps) {
  const { controls, provider } = deps;

  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    const base = '/operator/dev/erx';
    const read = { readOnly: 'read', auth: 'public', operatorAuth: 'session' } as const;
    const write = {
      readOnly: 'write',
      auth: 'public',
      operatorAuth: 'session',
      audits: 'none',
    } as const;

    async function state(): Promise<State> {
      const prescriptions = await controls.prescriptions(PRESCRIPTIONS_SHOWN);
      return {
        mode: await controls.mode(),
        prescriptions: prescriptions.map((prescription) => ({
          ...prescription,
          createdAt: prescription.createdAt.toISOString(),
        })),
      };
    }

    /** Signs a notice and posts it to the real webhook; true when the webhook accepted it. */
    async function notify(
      server: FastifyInstance,
      event: { externalId: string; state: 'dispensed' | 'expired' },
    ): Promise<boolean> {
      const raw = JSON.stringify({ eventId: randomUUID(), ...event });
      const response = await server.inject({
        method: 'POST',
        url: '/webhooks/erx',
        headers: {
          'content-type': 'application/json',
          ...provider.signNotice(raw),
        },
        payload: raw,
      });
      return response.statusCode === 200;
    }

    typed.get(
      `${base}/state`,
      { config: read, schema: { response: { 200: ErxSimulatorStateResponse } } },
      state,
    );

    typed.put(
      `${base}/mode`,
      {
        config: write,
        schema: { body: ErxSimulatorModeRequest, response: { 200: ErxSimulatorModeRequest } },
      },
      async (request) => {
        await controls.setMode(request.body.mode);
        return { mode: request.body.mode };
      },
    );

    typed.post(
      `${base}/advance`,
      {
        config: write,
        schema: {
          body: ErxSimulatorAdvanceRequest,
          response: { 200: ErxSimulatorAdvanceResponse },
        },
      },
      async (request) => {
        const moved = await controls.advance(request.body.externalId, request.body.to);
        // Only an issued prescription moves; anything else is not there for the console.
        if (!moved) throw new AppError('not_found');
        return {
          delivered: await notify(request.server, {
            externalId: request.body.externalId,
            state: request.body.to,
          }),
        };
      },
    );

    typed.post(
      `${base}/reset`,
      {
        config: write,
        schema: {
          body: z.strictObject({}).optional(),
          response: { 200: ErxSimulatorStateResponse },
        },
      },
      async () => {
        await controls.reset();
        return state();
      },
    );
  };
}
