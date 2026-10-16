import {
  LoginResponse,
  ReauthenticateRequest,
  RecoveryCodesResponse,
  TwoFactorConfirmRequest,
  TwoFactorEnrollStartRequest,
  TwoFactorEnrollStartResponse,
  TwoFactorVerifyRequest,
} from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { userAccount } from '../../../db/schema/identity.js';
import { tenant } from '../../../db/schema/tenant.js';
import { audit } from '../../../platform/audit/writer.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { primaryRole } from '../../../platform/http/auth-guard.js';
import { AppError } from '../../../platform/http/problem.js';
import {
  readSessionCookie,
  serializeSessionCookie,
} from '../../../platform/http/session-cookie.js';
import type { Reauthentication } from '../application/reauthentication.js';
import type { SecondFactorLogin } from '../application/second-factor-login.js';
import { SESSION_ABSOLUTE_MS, type SessionService } from '../application/sessions.js';
import { twoFactorRequirement } from '../application/two-factor-policy.js';
import type { TwoFactor } from '../application/two-factor.js';

export interface TwoFactorRoutesDeps {
  withTenant: WithTenant;
  twoFactor: TwoFactor;
  reauth: Reauthentication;
  sessions: SessionService;
  secondFactorLogin: SecondFactorLogin;
  cookieSecure: boolean;
  loginRateLimit?: { max: number; timeWindow: number };
}

const sessionCookie = (token: string, secure: boolean) =>
  serializeSessionCookie(token, { secure, maxAgeSeconds: SESSION_ABSOLUTE_MS / 1000 });

/** Routes of the second factor: completing a sign-in, enrolling, replacing and removing it. */
export function twoFactorRoutes(deps: TwoFactorRoutesDeps) {
  return (app: FastifyInstance): void => {
    app.addHook('onSend', (_request, reply, payload, done) => {
      void reply.header('cache-control', 'no-store');
      done(null, payload);
    });
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.post(
      '/auth/2fa',
      {
        config: {
          readOnly: 'auth',
          auth: 'public',
          ...(deps.loginRateLimit ? { rateLimit: deps.loginRateLimit } : {}),
        },
        schema: { body: TwoFactorVerifyRequest, response: { 200: LoginResponse } },
      },
      async (request, reply) => {
        const context = request.hostContext;
        if (context?.kind !== 'tenant') throw new AppError('unauthenticated');

        const outcome = await deps.secondFactorLogin.verify({
          tenantId: context.tenant.id,
          challenge: request.body.challenge,
          ...(request.body.code === undefined ? {} : { code: request.body.code }),
          ...(request.body.recoveryCode === undefined
            ? {}
            : { recoveryCode: request.body.recoveryCode }),
          actor: request.auditActor,
          previousToken: readSessionCookie(request.headers.cookie),
        });
        if (outcome.kind !== 'session') throw new AppError('unauthenticated');

        void reply.header('set-cookie', sessionCookie(outcome.issued.token, deps.cookieSecure));
        return { next: 'authenticated' as const };
      },
    );

    typed.post(
      '/auth/2fa/enroll/start',
      {
        config: { readOnly: 'auth', auth: 'session', allowEnrollmentScope: true },
        schema: {
          body: TwoFactorEnrollStartRequest,
          response: { 200: TwoFactorEnrollStartResponse },
        },
      },
      async (request) => {
        const current = request.session;
        if (!current) throw new AppError('unauthenticated');
        const result = await deps.withTenant(
          { tenantId: current.tenantId, userId: current.userId },
          async (tx) => {
            const enrolled = (await deps.twoFactor.status(tx, current.userId)).enrolled;
            // Replacing a working factor is a sensitive change: the password is asked again.
            if (enrolled) {
              const password = request.body.password;
              const proven =
                password !== undefined &&
                (await deps.reauth.confirmPassword(
                  tx,
                  current.userId,
                  password,
                  request.auditActor,
                ));
              if (!proven) return null;
            }
            const [account] = await tx
              .select({ email: userAccount.email })
              .from(userAccount)
              .where(eq(userAccount.id, current.userId));
            const [organization] = await tx.select({ slug: tenant.slug }).from(tenant);
            return deps.twoFactor.beginEnrollment(tx, {
              tenantId: current.tenantId,
              userId: current.userId,
              account: account?.email ?? '',
              issuer: `Consultorio ${organization?.slug ?? ''}`.trim(),
            });
          },
        );
        if (result === null) throw new AppError('unauthenticated');
        return { secret: result.secretBase32, otpauthUri: result.otpauthUri };
      },
    );

    typed.post(
      '/auth/2fa/enroll/confirm',
      {
        config: { readOnly: 'auth', auth: 'session', allowEnrollmentScope: true },
        schema: { body: TwoFactorConfirmRequest, response: { 200: RecoveryCodesResponse } },
      },
      async (request, reply) => {
        const current = request.session;
        if (!current) throw new AppError('unauthenticated');
        const outcome = await deps.withTenant(
          { tenantId: current.tenantId, userId: current.userId },
          async (tx) => {
            const replaced = (await deps.twoFactor.status(tx, current.userId)).enrolled;
            const confirmed = await deps.twoFactor.confirmEnrollment(tx, {
              tenantId: current.tenantId,
              userId: current.userId,
              code: request.body.code,
            });
            if (!confirmed.ok) return null;
            await audit(tx, {
              action: 'auth.2fa.enrolled',
              outcome: 'allow',
              actor: request.auditActor,
              resourceType: 'user',
              resourceId: current.userId,
              metadata: { replaced },
            });
            // A session that could only enroll becomes a full one: the privilege changed, so the
            // token changes too.
            const upgraded =
              current.scope === 'two_factor_enrollment'
                ? await deps.sessions.rotate(tx, current.sessionId, 'privilege_changed', {
                    scope: 'full',
                  })
                : null;
            return { recoveryCodes: confirmed.recoveryCodes, upgraded };
          },
        );
        if (outcome === null) throw new AppError('bad_request');
        if (outcome.upgraded) {
          void reply.header('set-cookie', sessionCookie(outcome.upgraded.token, deps.cookieSecure));
        }
        return { recoveryCodes: outcome.recoveryCodes };
      },
    );

    typed.post(
      '/auth/2fa/recovery-codes',
      {
        config: { readOnly: 'auth', auth: 'session' },
        schema: { body: ReauthenticateRequest, response: { 200: RecoveryCodesResponse } },
      },
      async (request) => {
        const current = request.session;
        if (!current) throw new AppError('unauthenticated');
        const codes = await deps.withTenant(
          { tenantId: current.tenantId, userId: current.userId },
          async (tx) => {
            const proven = await deps.reauth.confirmPassword(
              tx,
              current.userId,
              request.body.password,
              request.auditActor,
            );
            if (!proven) return null;
            if (!(await deps.twoFactor.status(tx, current.userId)).enrolled) return 'not_enrolled';
            const fresh = await deps.twoFactor.regenerateRecoveryCodes(tx, current.userId);
            await audit(tx, {
              action: 'auth.2fa.recovery_regenerated',
              outcome: 'allow',
              actor: request.auditActor,
              resourceType: 'user',
              resourceId: current.userId,
            });
            return fresh;
          },
        );
        if (codes === null) throw new AppError('unauthenticated');
        if (codes === 'not_enrolled') throw new AppError('conflict');
        return { recoveryCodes: codes };
      },
    );

    typed.post(
      '/auth/2fa/disable',
      {
        config: { readOnly: 'auth', auth: 'session' },
        schema: { body: ReauthenticateRequest },
      },
      async (request, reply) => {
        const current = request.session;
        if (!current) throw new AppError('unauthenticated');
        const outcome = await deps.withTenant(
          { tenantId: current.tenantId, userId: current.userId },
          async (tx) => {
            const [organization] = await tx.select({ settings: tenant.settings }).from(tenant);
            const obliged = twoFactorRequirement({
              roles: current.roles,
              enrolled: false,
              firstSignInAt: null,
              organizationRequires: organization?.settings['require_2fa'] === true,
              now: new Date(),
            }).required;
            // A mandatory role may replace the factor but never remove it.
            if (obliged) return 'mandatory';

            const proven = await deps.reauth.confirmPassword(
              tx,
              current.userId,
              request.body.password,
              request.auditActor,
            );
            if (!proven) return 'password';
            await deps.twoFactor.disable(tx, current.userId);
            await audit(tx, {
              action: 'auth.2fa.disabled',
              outcome: 'allow',
              actor: { ...request.auditActor, actingRole: primaryRole(current.roles) },
              resourceType: 'user',
              resourceId: current.userId,
            });
            return 'done';
          },
        );
        if (outcome === 'mandatory') throw new AppError('forbidden');
        if (outcome === 'password') throw new AppError('unauthenticated');
        return reply.code(204).send();
      },
    );
  };
}
