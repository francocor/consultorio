import {
  InvitationAcceptRequest,
  PasswordResetCompleteRequest,
  PasswordResetRequest,
  effectivePermissions,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { InvitationAcceptance } from '../application/invitations.js';
import type { PasswordReset, ResetLinkContext } from '../application/password-reset.js';

export interface RecoveryRoutesDeps {
  withTenant: WithTenant;
  passwordReset: PasswordReset;
  invitations: InvitationAcceptance;
  /** `https` unless the deployment is plain-http local development. */
  secureLinks: boolean;
  loginRateLimit?: { max: number; timeWindow: number };
}

const UserParams = z.strictObject({ id: z.uuid() });
const NoBody = z.strictObject({});

/**
 * Routes for getting back into an account or joining one: reset by email, reset triggered by an
 * administrator, and invitation acceptance. None of them lets anyone set another person's
 * password: the person sets their own, with a link only their email address received.
 */
export function recoveryRoutes(deps: RecoveryRoutesDeps) {
  return (app: FastifyInstance): void => {
    app.addHook('onSend', (_request, reply, payload, done) => {
      void reply.header('cache-control', 'no-store');
      done(null, payload);
    });
    const typed = app.withTypeProvider<ZodTypeProvider>();
    const publicConfig = {
      readOnly: 'auth',
      auth: 'public',
      ...(deps.loginRateLimit ? { rateLimit: deps.loginRateLimit } : {}),
    } as const;

    /** Where links in the email point: the tenant's own host, as the request reached it. */
    function linkContext(request: FastifyRequest): ResetLinkContext {
      const context = request.hostContext;
      if (context?.kind !== 'tenant') throw new AppError('unauthenticated');
      const host = request.headers.host ?? '';
      return {
        tenantId: context.tenant.id,
        // The display name of the organization arrives with branding (S1.25); the slug until then.
        organizationName: context.tenant.slug,
        baseUrl: `${deps.secureLinks ? 'https' : 'http'}://${host}`,
        actor: request.auditActor,
      };
    }

    typed.post(
      '/auth/password-reset/request',
      { config: publicConfig, schema: { body: PasswordResetRequest } },
      (request, reply) => {
        const context = linkContext(request);
        // The work happens after the answer: how long it takes must not tell whether the account
        // exists. The answer itself is the same for everyone.
        request.server.background.run(() =>
          deps.passwordReset.requestByEmail(context, request.body.email),
        );
        return reply.code(204).send();
      },
    );

    typed.post(
      '/auth/password-reset/complete',
      { config: publicConfig, schema: { body: PasswordResetCompleteRequest } },
      async (request, reply) => {
        const context = request.hostContext;
        if (context?.kind !== 'tenant') throw new AppError('bad_request');
        await deps.passwordReset.complete({
          tenantId: context.tenant.id,
          token: request.body.token,
          password: request.body.password,
          actor: request.auditActor,
        });
        return reply.code(204).send();
      },
    );

    typed.post(
      '/auth/invitations/accept',
      { config: publicConfig, schema: { body: InvitationAcceptRequest } },
      async (request, reply) => {
        const context = request.hostContext;
        if (context?.kind !== 'tenant') throw new AppError('bad_request');
        await deps.invitations.accept({
          tenantId: context.tenant.id,
          token: request.body.token,
          password: request.body.password,
          actor: request.auditActor,
        });
        return reply.code(204).send();
      },
    );

    typed.post(
      '/users/:id/password-reset',
      {
        config: { readOnly: 'auth', auth: 'session' },
        schema: { params: UserParams, body: NoBody.optional() },
      },
      async (request, reply) => {
        const current = request.session;
        if (!current) throw new AppError('unauthenticated');
        // Only those who manage staff may trigger it. (The permission guard of S1.15 takes over.)
        if (!effectivePermissions(current.roles, []).includes('staff.manage')) {
          throw new AppError('forbidden');
        }
        // The email goes to the target's own address. The password is never set here.
        const sent = await deps.passwordReset.requestForMember(
          linkContext(request),
          request.params.id,
        );
        if (sent === 'not_a_member') throw new AppError('not_found');
        return reply.code(204).send();
      },
    );
  };
}
