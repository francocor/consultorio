import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { VideoJoinAddress } from '../application/join-address.js';

/**
 * What the simulator console can do with the video side. It stands in for the reminder that will
 * carry the patient's address (the messaging track): a developer or a demo operator asks for the
 * address a reminder would have had, and opens it as the patient would.
 */
export interface DevVideoControls {
  issuePatientLink(input: { tenantId: string; appointmentId: string }): Promise<VideoJoinAddress>;
}

const IssueLinkRequest = z.strictObject({ tenantId: z.uuid(), appointmentId: z.uuid() });

const IssueLinkResponse = z.strictObject({
  kind: z.enum(['in_person', 'pending', 'closed', 'link']),
  url: z.string().nullable(),
});

/**
 * `POST /operator/dev/video/links`: the platform join address of an appointment, as the reminder
 * would carry it. It exists only while the provider console is on (`LOCAL_PROVIDERS_CONSOLE`), and
 * only for a signed-in platform operator, so no tenant user can ever ask for a patient's address.
 */
export function devVideoRoutes(controls: () => DevVideoControls) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.post(
      '/operator/dev/video/links',
      {
        config: {
          readOnly: 'write',
          auth: 'public',
          operatorAuth: 'session',
          audits: 'none',
        },
        schema: { body: IssueLinkRequest, response: { 200: IssueLinkResponse } },
      },
      async (request) => {
        const address = await controls().issuePatientLink(request.body);
        return { kind: address.kind, url: address.kind === 'link' ? address.url : null };
      },
    );
  };
}
