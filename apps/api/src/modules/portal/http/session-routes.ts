import { PortalSessionsResponse } from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { audit } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID, type Tx, type WithTenant } from '../../../platform/db/tenant-context.js';
import { clearPortalCookie } from '../../../platform/http/portal-session.js';
import { AppError } from '../../../platform/http/problem.js';
import type { PortalSessions } from '../application/sessions.js';

export interface SessionRoutesDeps {
  withTenant: WithTenant;
  sessions: PortalSessions;
  clock: () => Date;
  cookieSecure: boolean;
}

const IdParams = z.strictObject({ id: z.uuid() });

/**
 * The sessions of the person who is signed in (task 5.30, spec "Patient authentication"): see them,
 * end another one, sign out. Sign-in and sign-out are authentication, so they stay open in a
 * read-only organization.
 */
export function sessionRoutes(deps: SessionRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    function who(request: FastifyRequest) {
      const actor = request.portalActor;
      const session = request.portalSession;
      if (!actor || !session) throw new AppError('unauthenticated');
      return { actor, session };
    }
    const run = <T>(actor: { tenantId: string }, work: (tx: Tx) => Promise<T>) =>
      deps.withTenant({ tenantId: actor.tenantId, userId: SYSTEM_USER_ID }, work);

    typed.get(
      '/portal/sessions',
      {
        config: { readOnly: 'read', auth: 'portal', portalPermission: 'portal.self.read' },
        schema: { response: { 200: PortalSessionsResponse } },
      },
      async (request) => {
        const { actor, session } = who(request);
        const sessions = await run(actor, (tx) =>
          deps.sessions.list(tx, actor.identityId, session.sessionId, deps.clock()),
        );
        return {
          sessions: sessions.map((entry) => ({
            id: entry.id,
            createdAt: entry.createdAt.toISOString(),
            lastSeenAt: entry.lastSeenAt.toISOString(),
            expiresAt: entry.expiresAt.toISOString(),
            userAgent: entry.userAgent,
            current: entry.current,
          })),
        };
      },
    );

    typed.delete(
      '/portal/sessions/:id',
      {
        config: {
          readOnly: 'auth',
          auth: 'portal',
          portalPermission: 'portal.self.read',
          audits: ['auth.session.revoked'],
        },
        schema: { params: IdParams },
      },
      async (request, reply) => {
        const { actor, session } = who(request);
        await run(actor, async (tx) => {
          const now = deps.clock();
          // Only a session of this person: another's answers as if it did not exist.
          const mine = await deps.sessions.list(tx, actor.identityId, session.sessionId, now);
          if (!mine.some((entry) => entry.id === request.params.id))
            throw new AppError('not_found');
          await deps.sessions.revoke(tx, request.params.id, 'revoked_by_patient', now);
          await audit(tx, {
            action: 'auth.session.revoked',
            outcome: 'allow',
            actor: request.auditActor,
            resourceType: 'portal_session',
            resourceId: request.params.id,
            metadata: { scope: 'portal', own: request.params.id === session.sessionId },
          });
        });
        return reply.code(204).send();
      },
    );

    typed.post(
      '/portal/logout',
      {
        config: {
          readOnly: 'auth',
          auth: 'portal',
          portalPermission: 'portal.self.read',
          audits: ['auth.logout'],
        },
        schema: { body: z.strictObject({}).optional() },
      },
      async (request, reply) => {
        const { actor, session } = who(request);
        await run(actor, async (tx) => {
          await deps.sessions.revoke(tx, session.sessionId, 'logout', deps.clock());
          await audit(tx, {
            action: 'auth.logout',
            outcome: 'allow',
            actor: request.auditActor,
            resourceType: 'portal_session',
            resourceId: session.sessionId,
            metadata: { scope: 'portal' },
          });
        });
        return reply
          .header('set-cookie', clearPortalCookie({ secure: deps.cookieSecure }))
          .code(204)
          .send();
      },
    );
  };
}
