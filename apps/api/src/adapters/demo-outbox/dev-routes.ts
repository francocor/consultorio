import { DemoOutboxQuery, DemoOutboxResponse } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { DevProvider } from '../../platform/local-providers/dev-routes.js';

import type { DemoOutboxReader } from './index.js';

/** The most messages one listing returns: the console shows the latest, not the whole history. */
export const DEMO_OUTBOX_SHOWN = 100;

/**
 * The demo outbox in the provider console (`/operator/dev/demo-outbox`, task 5.48): what the demo
 * organizations "sent", newest first, optionally only to one address. It exists only while
 * `LOCAL_PROVIDERS_CONSOLE=true` and lives inside the operator console, so it answers only on the
 * platform host behind the operator session. Read only: there is nothing to change here.
 */
export function demoOutboxDevProvider(reader: DemoOutboxReader): DevProvider {
  return {
    id: 'demo-outbox',
    label: 'Correo de la demo',
    // It is not an external provider with a mode: the email of the demo organizations is kept here
    // instead of being sent.
    status: () => Promise.resolve({ adapter: 'local', mode: null }),
    routes: (app: FastifyInstance) => {
      const typed = app.withTypeProvider<ZodTypeProvider>();
      typed.get(
        '/operator/dev/demo-outbox',
        {
          config: { readOnly: 'read', auth: 'public', operatorAuth: 'session' },
          schema: { querystring: DemoOutboxQuery, response: { 200: DemoOutboxResponse } },
        },
        async (request) => {
          const messages = await reader.list({
            limit: DEMO_OUTBOX_SHOWN,
            to: request.query.to,
          });
          return {
            messages: messages.map((message) => ({
              ...message,
              createdAt: message.createdAt.toISOString(),
            })),
          };
        },
      );
    },
  };
}
