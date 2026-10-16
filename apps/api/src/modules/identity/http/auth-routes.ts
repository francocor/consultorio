import {
  LoginRequest,
  LoginResponse,
  MeResponse,
  SessionList,
  effectivePermissions,
} from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { userAccount } from '../../../db/schema/identity.js';
import { audit } from '../../../platform/audit/writer.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { primaryRole } from '../../../platform/http/auth-guard.js';
import { AppError, denied } from '../../../platform/http/problem.js';
import {
  clearSessionCookie,
  readSessionCookie,
  serializeSessionCookie,
} from '../../../platform/http/session-cookie.js';
import type { LoginService } from '../application/login.js';
import { SESSION_ABSOLUTE_MS, type SessionService } from '../application/sessions.js';

export interface AuthRoutesDeps {
  withTenant: WithTenant;
  login: LoginService;
  sessions: SessionService;
  cookieSecure: boolean;
}

const SessionIdParams = z.strictObject({ id: z.uuid() });

/** Routes of sign-in, sign-out and the user's own sessions. All answers are `no-store`. */
export function authRoutes(deps: AuthRoutesDeps) {
  return (app: FastifyInstance): void => {
    app.addHook('onSend', (_request, reply, payload, done) => {
      void reply.header('cache-control', 'no-store');
      done(null, payload);
    });
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.post(
      '/auth/login',
      {
        config: { readOnly: 'auth', auth: 'public' },
        schema: { body: LoginRequest, response: { 200: LoginResponse } },
      },
      async (request, reply) => {
        const context = request.hostContext;
        if (context?.kind !== 'tenant') throw new AppError('unauthenticated');

        const outcome = await deps.login.login({
          tenantId: context.tenant.id,
          email: request.body.email,
          password: request.body.password,
          actor: request.auditActor,
          previousToken: readSessionCookie(request.headers.cookie),
        });
        // Every failure is the same answer: it must not say which part was wrong.
        if (outcome.kind === 'failed') throw new AppError('unauthenticated');

        void reply.header(
          'set-cookie',
          serializeSessionCookie(outcome.issued.token, {
            secure: deps.cookieSecure,
            maxAgeSeconds: SESSION_ABSOLUTE_MS / 1000,
          }),
        );
        return {
          next: outcome.scope === 'full' ? ('authenticated' as const) : ('enrollment' as const),
        };
      },
    );

    typed.post(
      '/auth/logout',
      { config: { readOnly: 'auth', auth: 'session' } },
      async (request, reply) => {
        const current = request.session;
        if (!current) throw new AppError('unauthenticated');
        await deps.withTenant(
          { tenantId: current.tenantId, userId: current.userId },
          async (tx) => {
            await deps.sessions.revoke(tx, current.sessionId, 'logout');
            await audit(tx, {
              action: 'auth.logout',
              outcome: 'allow',
              actor: request.auditActor,
              resourceType: 'session',
              resourceId: current.sessionId,
            });
          },
        );
        void reply.header('set-cookie', clearSessionCookie({ secure: deps.cookieSecure }));
        return reply.code(204).send();
      },
    );

    typed.get(
      '/auth/me',
      {
        config: { readOnly: 'read', auth: 'session' },
        schema: { response: { 200: MeResponse } },
      },
      async (request) => {
        const current = request.session;
        if (!current) throw new AppError('unauthenticated');
        const email = await deps.withTenant(
          { tenantId: current.tenantId, userId: current.userId },
          async (tx) => {
            const [row] = await tx
              .select({ email: userAccount.email })
              .from(userAccount)
              .where(eq(userAccount.id, current.userId));
            return row?.email;
          },
        );
        if (email === undefined) throw new AppError('unauthenticated');
        return {
          user: { id: current.userId, email },
          roles: [...current.roles],
          // Grantable permissions are added when the access module exists (S1.18).
          permissions: effectivePermissions(current.roles, []),
          scope: current.scope,
        };
      },
    );

    typed.get(
      '/auth/sessions',
      {
        config: { readOnly: 'read', auth: 'session' },
        schema: { response: { 200: SessionList } },
      },
      async (request) => {
        const current = request.session;
        if (!current) throw new AppError('unauthenticated');
        const entries = await deps.withTenant(
          { tenantId: current.tenantId, userId: current.userId },
          (tx) => deps.sessions.listForUser(tx, current.userId, current.sessionId),
        );
        return {
          sessions: entries.map((entry) => ({
            ...entry,
            createdAt: entry.createdAt.toISOString(),
            lastSeenAt: entry.lastSeenAt.toISOString(),
            expiresAt: entry.expiresAt.toISOString(),
          })),
        };
      },
    );

    typed.delete(
      '/auth/sessions/:id',
      {
        config: { readOnly: 'auth', auth: 'session' },
        schema: { params: SessionIdParams },
      },
      async (request, reply) => {
        const current = request.session;
        if (!current) throw new AppError('unauthenticated');
        const target = request.params.id;
        const revoked = await deps.withTenant(
          { tenantId: current.tenantId, userId: current.userId },
          async (tx) => {
            // Only the user's own live sessions can be revoked here; anything else "does not exist".
            const own = await deps.sessions.listForUser(tx, current.userId, current.sessionId);
            if (!own.some((entry) => entry.id === target)) return false;
            const changed = await deps.sessions.revoke(tx, target, 'revoked_by_user');
            if (changed) {
              await audit(tx, {
                action: 'auth.session.revoked',
                outcome: 'allow',
                actor: { ...request.auditActor, actingRole: primaryRole(current.roles) },
                resourceType: 'session',
                resourceId: target,
                metadata: { reason: 'revoked_by_user', own: true },
              });
            }
            return changed;
          },
        );
        if (!revoked) return denied(request, reply);
        // Revoking the session in use is a sign-out: drop the cookie too.
        if (target === current.sessionId) {
          void reply.header('set-cookie', clearSessionCookie({ secure: deps.cookieSecure }));
        }
        return reply.code(204).send();
      },
    );
  };
}
