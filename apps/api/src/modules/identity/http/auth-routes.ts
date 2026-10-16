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
import { tenant } from '../../../db/schema/tenant.js';
import { audit } from '../../../platform/audit/writer.js';
import { noGrants, type GrantsRepo } from '../../../platform/authz/guard.js';
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
import { twoFactorRequirement } from '../application/two-factor-policy.js';
import type { TwoFactor } from '../application/two-factor.js';

export interface AuthRoutesDeps {
  withTenant: WithTenant;
  login: LoginService;
  sessions: SessionService;
  twoFactor: TwoFactor;
  cookieSecure: boolean;
  /** Where the grantable permissions of the member come from. None until the access module is wired. */
  grants?: GrantsRepo;
  /** Sign-in attempts per client address and tenant. */
  loginRateLimit?: { max: number; timeWindow: number };
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
        config: {
          audits: [
            'auth.login.success',
            'auth.login.failed',
            'auth.login.locked',
            'auth.account.locked',
          ],
          readOnly: 'auth',
          auth: 'public',
          ...(deps.loginRateLimit ? { rateLimit: deps.loginRateLimit } : {}),
        },
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
        // The password was right and a code is needed: no session yet, just the challenge.
        if (outcome.kind === 'challenge') {
          return { next: 'totp' as const, challenge: outcome.challenge };
        }

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
      {
        config: {
          audits: ['auth.logout'],
          readOnly: 'auth',
          auth: 'session',
          allowEnrollmentScope: true,
        },
      },
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
        config: { readOnly: 'read', auth: 'session', allowEnrollmentScope: true },
        schema: { response: { 200: MeResponse } },
      },
      async (request) => {
        const current = request.session;
        if (!current) throw new AppError('unauthenticated');
        const profile = await deps.withTenant(
          { tenantId: current.tenantId, userId: current.userId },
          async (tx) => {
            const [row] = await tx
              .select({
                email: userAccount.email,
                firstSignInAt: userAccount.firstSignInAt,
              })
              .from(userAccount)
              .where(eq(userAccount.id, current.userId));
            const [organization] = await tx.select({ settings: tenant.settings }).from(tenant);
            const enrolled = (await deps.twoFactor.status(tx, current.userId)).enrolled;
            return { row, enrolled, settings: organization?.settings };
          },
        );
        if (profile.row === undefined) throw new AppError('unauthenticated');
        // A failure reading the grants counts as none: roles alone decide (fail closed).
        const grants = await (deps.grants ?? noGrants)
          .grantsFor(current.tenantId, current.membershipId)
          .catch(() => []);
        const email = profile.row.email;
        const requirement = twoFactorRequirement({
          roles: current.roles,
          enrolled: profile.enrolled,
          firstSignInAt: profile.row.firstSignInAt,
          organizationRequires: profile.settings?.['require_2fa'] === true,
          now: new Date(),
        });
        return {
          user: { id: current.userId, email },
          roles: [...current.roles],
          permissions: effectivePermissions(current.roles, grants),
          scope: current.scope,
          twoFactor: {
            enrolled: profile.enrolled,
            required: requirement.required,
            graceEndsAt: requirement.graceEndsAt?.toISOString() ?? null,
          },
          tenantStatus:
            request.hostContext?.kind === 'tenant' ? request.hostContext.tenant.status : 'active',
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
        config: { audits: ['auth.session.revoked'], readOnly: 'auth', auth: 'session' },
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
