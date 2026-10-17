import {
  CreateTenantRequest,
  CreateTenantResponse,
  DemoResetResponse,
  OperatorDto,
  OperatorLoginRequest,
  OperatorTenantListResponse,
  ResendOwnerInvitationRequest,
  ResendOwnerInvitationResponse,
  SupportOverviewResponse,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { PlatformAuditActor } from '../../../platform/audit/platform-audit.js';
import { denied, AppError } from '../../../platform/http/problem.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import { EmailDeliveryError, type EmailSender } from '../../../platform/mail/email-sender.js';
import { renderInvitationEmail } from '../../../platform/mail/templates.js';
import { TOKEN_KIND_REGISTRY } from '../../../platform/tokens/index.js';
import {
  OPERATOR_SESSION_ABSOLUTE_MS,
  type OperatorAuth,
  type OperatorSessionInfo,
} from '../application/auth.js';
import type { OperatorIdentity } from '../application/context.js';
import type { OperatorSupport } from '../application/support.js';
import type { OperatorTenants, OwnerInvitation } from '../application/tenants.js';

import { clearOperatorCookie, readOperatorCookie, serializeOperatorCookie } from './cookie.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * How an operator route is protected. `public` is the sign-in; `session` needs a live operator
     * session. A route under `/operator/` that declares neither fails at boot.
     */
    operatorAuth?: 'public' | 'session';
  }
  interface FastifyRequest {
    /** The signed-in operator. Set by the console's own guard on `session` routes. */
    operator: OperatorSessionInfo | null;
  }
}

export interface OperatorRoutesDeps {
  auth: OperatorAuth;
  tenants: OperatorTenants;
  support: OperatorSupport;
  email: EmailSender;
  /** Where an organization's emailed links point (the console is on the platform host). */
  origins: PublicOrigins;
  /** `https` unless the deployment is plain-http local development. */
  secureLinks: boolean;
  /** Sign-in attempts per client address and minute. */
  loginRateLimit: { max: number; timeWindow: number };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DAY_MS = 86_400_000;
/** The screen of the web app where the owner chooses a password. */
const INVITATION_PATH = '/accept-invitation';

const TenantParams = z.strictObject({ tenantId: z.uuid() });

function hostOfOrigin(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function metaOf(request: FastifyRequest): Omit<PlatformAuditActor, 'operatorId'> {
  const { ip, userAgent, requestId } = request.auditActor;
  return { ip, userAgent, requestId };
}

function operatorOf(request: FastifyRequest): OperatorIdentity {
  if (!request.operator) throw new AppError('unauthenticated');
  return request.operator.operator;
}

/**
 * The operator console API. It answers ONLY on the platform host: on a tenant host (or any other)
 * every `/operator/*` path is the same 404 as an unknown route, so a tenant user cannot even tell
 * the console exists. It has its own sign-in (password and a mandatory authenticator code), its own
 * cookie and its own audit trail.
 */
export function operatorRoutes(deps: OperatorRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    app.decorateRequest('operator', null);

    app.addHook('onRoute', (route) => {
      if (route.config?.operatorAuth !== 'public' && route.config?.operatorAuth !== 'session') {
        throw new Error(`Operator route ${route.url} must declare config.operatorAuth`);
      }
    });

    app.addHook('onRequest', async (request, reply) => {
      if (request.is404) return undefined;
      if (request.hostContext?.kind !== 'platform') return denied(request, reply);

      // Defence in depth on top of SameSite=Strict: a change must come from the console's own page.
      if (!SAFE_METHODS.has(request.method)) {
        const origin = request.headers.origin;
        const hasCookie =
          readOperatorCookie(request.headers.cookie, { secure: deps.secureLinks }) !== null;
        const allowed =
          origin === undefined ? !hasCookie : hostOfOrigin(origin) === request.headers.host;
        if (!allowed) throw new AppError('forbidden');
      }

      if (request.routeOptions.config.operatorAuth === 'public') return undefined;
      const token = readOperatorCookie(request.headers.cookie, { secure: deps.secureLinks });
      const session = token === null ? null : await deps.auth.resolve(token);
      if (!session) {
        void reply.header('set-cookie', clearOperatorCookie({ secure: deps.secureLinks }));
        throw new AppError('unauthenticated');
      }
      request.operator = session;
      return undefined;
    });

    async function sendInvitation(
      request: FastifyRequest,
      invitation: OwnerInvitation,
    ): Promise<boolean> {
      const origin = deps.origins(invitation.slug);
      try {
        await deps.email.send({
          to: invitation.email,
          tenant: invitation.tenant,
          ...renderInvitationEmail({
            organizationName: invitation.organizationName,
            link: `${origin}${INVITATION_PATH}?token=${invitation.token}`,
            expiresInDays: Math.round(TOKEN_KIND_REGISTRY.staff_invitation.ttlMs / DAY_MS),
          }),
        });
        return true;
      } catch (error) {
        if (error instanceof EmailDeliveryError) return false;
        throw error;
      }
    }

    typed.post(
      '/operator/auth/login',
      {
        config: {
          readOnly: 'auth',
          auth: 'public',
          operatorAuth: 'public',
          rateLimit: deps.loginRateLimit,
        },
        schema: { body: OperatorLoginRequest, response: { 200: OperatorDto } },
      },
      async (request, reply) => {
        const session = await deps.auth.login(request.body, metaOf(request));
        return reply
          .header(
            'set-cookie',
            serializeOperatorCookie(session.token, {
              secure: deps.secureLinks,
              maxAgeSeconds: OPERATOR_SESSION_ABSOLUTE_MS / 1000,
            }),
          )
          .send(session.operator);
      },
    );

    typed.post(
      '/operator/auth/logout',
      {
        config: { readOnly: 'auth', auth: 'public', operatorAuth: 'session' },
      },
      async (request, reply) => {
        if (!request.operator) throw new AppError('unauthenticated');
        await deps.auth.logout(request.operator, metaOf(request));
        return reply
          .header('set-cookie', clearOperatorCookie({ secure: deps.secureLinks }))
          .code(204)
          .send();
      },
    );

    typed.get(
      '/operator/me',
      {
        config: { readOnly: 'read', auth: 'public', operatorAuth: 'session' },
        schema: { response: { 200: OperatorDto } },
      },
      (request) => operatorOf(request),
    );

    typed.get(
      '/operator/tenants',
      {
        config: { readOnly: 'read', auth: 'public', operatorAuth: 'session' },
        schema: { response: { 200: OperatorTenantListResponse } },
      },
      async () => ({ tenants: await deps.tenants.list() }),
    );

    typed.post(
      '/operator/tenants',
      {
        config: { readOnly: 'write', auth: 'public', operatorAuth: 'session' },
        schema: { body: CreateTenantRequest, response: { 201: CreateTenantResponse } },
      },
      async (request, reply) => {
        const created = await deps.tenants.create(
          request.body,
          operatorOf(request),
          metaOf(request),
        );
        // The link goes by email only, once the organization is safely stored. The response never
        // carries it.
        const invitationSent = await sendInvitation(request, created.invitation);
        return reply.code(201).send({
          tenant: created.tenant,
          invitationSent,
          invitationExpiresAt: created.invitation.expiresAt.toISOString(),
        });
      },
    );

    typed.post(
      '/operator/tenants/:tenantId/owner-invitation',
      {
        config: { readOnly: 'write', auth: 'public', operatorAuth: 'session' },
        schema: {
          params: TenantParams,
          body: ResendOwnerInvitationRequest,
          response: { 200: ResendOwnerInvitationResponse },
        },
      },
      async (request) => {
        const invitation = await deps.tenants.reissueOwnerInvitation(
          request.params.tenantId,
          request.body.ownerEmail,
          operatorOf(request),
          metaOf(request),
        );
        return {
          invitationSent: await sendInvitation(request, invitation),
          invitationExpiresAt: invitation.expiresAt.toISOString(),
        };
      },
    );

    typed.post(
      '/operator/tenants/:tenantId/demo-reset',
      {
        config: { readOnly: 'write', auth: 'public', operatorAuth: 'session' },
        schema: { params: TenantParams, response: { 200: DemoResetResponse } },
      },
      async (request) => {
        await deps.tenants.demoReset(request.params.tenantId, operatorOf(request), metaOf(request));
        return { status: 'done' as const };
      },
    );

    typed.get(
      '/operator/tenants/:tenantId/support/overview',
      {
        config: { readOnly: 'read', auth: 'public', operatorAuth: 'session' },
        schema: { params: TenantParams, response: { 200: SupportOverviewResponse } },
      },
      (request) =>
        deps.support.overview(request.params.tenantId, operatorOf(request), metaOf(request)),
    );
  };
}
