import type { AuditAction } from '@consultorio/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AuditActor } from '../audit/writer.js';
import { SYSTEM_USER_ID, type Tx, type WithTenant } from '../db/tenant-context.js';
import { denied } from '../http/problem.js';
import type { ActionTokens, TokenKind } from '../tokens/index.js';

import {
  PAGE_CONTENT_SECURITY_POLICY,
  renderTokenPage,
  type TokenPageModel,
} from './token-page.js';

/**
 * The public address of every emailed link: `GET|POST /public/t/<token>` (design 4.5, spec
 * "Confirmation by the patient"). One door for every kind of link; what a link does is up to the
 * handler its kind registered, so the capabilities (notifications, online booking, the waitlist,
 * teleconsultation) plug in with `registerTokenHandler` and none of them owns a public route.
 *
 * - A GET only LOOKS: it shows what the link is about and a button. Mail scanners and link
 *   previews open links, so a GET never spends a token.
 * - A POST ACTS: the handler spends the token and does what it is for.
 * - An unknown, tampered, expired, spent or revoked token gets one identical answer (404, same
 *   page): nothing tells a guesser which of these it was, or whether the appointment exists.
 * - The page names the appointment's date, time, place and professional, never more.
 * - In a read-only organization only the kinds that protect the patient (cancel, opt out) work;
 *   the rest answer 402 with a plain page.
 */

export interface TokenPage extends Omit<TokenPageModel, 'organizationName'> {
  /** The HTTP status; 200 when absent. */
  status?: number;
}

export interface TokenContext {
  tx: Tx;
  tenantId: string;
  now: Date;
  kind: TokenKind;
  /** What the link is about (an appointment, a patient, an offer). */
  subjectId: string;
  /** The small facts the issuer stored with the token. */
  payload: Record<string, unknown>;
  /** Who is acting for the audit trail: the visitor, by address and browser, with no account. */
  actor: AuditActor;
  /**
   * Spends the token. False when somebody else spent it first (two taps at once): then the handler
   * does nothing. Call it only when the handler is about to act.
   */
  redeem(): Promise<boolean>;
}

export interface TokenHandler {
  /** True when the action still works while the organization is read-only (cancel, opt out). */
  allowedWhenReadOnly: boolean;
  /** The audit actions `perform` may write; the route declares them. */
  audits: readonly AuditAction[];
  /** What a live link is about, without spending it. Null: show the generic page. */
  describe(context: TokenContext): Promise<TokenPage | null>;
  /** Does what the link is for. Null: show the generic page. */
  perform(context: TokenContext): Promise<TokenPage | null>;
}

const handlers = new Map<TokenKind, TokenHandler>();

/**
 * Registers what a kind of link does. Registering a kind again replaces the handler (an
 * application is built once per process in production; tests build many). Returns a function that
 * removes it.
 */
export function registerTokenHandler(kind: TokenKind, handler: TokenHandler): () => void {
  handlers.set(kind, handler);
  return () => {
    if (handlers.get(kind) === handler) handlers.delete(kind);
  };
}

/** The kinds that have a handler, in a stable order. */
export function registeredTokenKinds(): TokenKind[] {
  return [...handlers.keys()].sort();
}

export interface TokenRouterOptions {
  withTenant: WithTenant;
  tokens: ActionTokens;
  clock?: (() => Date) | undefined;
  /** The name of the organization of the transaction, for the heading of every page. */
  organizationName(tx: Tx): Promise<string>;
}

const INVALID: TokenPage = {
  title: 'Este enlace no es válido',
  message:
    'El enlace no existe, venció o ya se usó. Si necesita ayuda, comuníquese con la organización.',
  status: 404,
};

const READ_ONLY: TokenPage = {
  title: 'No es posible realizar esta acción ahora',
  message: 'En este momento esta acción no está disponible. Comuníquese con la organización.',
  status: 402,
};

const Params = z.strictObject({ token: z.string().min(1).max(512) });

/** A form posts `application/x-www-form-urlencoded`; the button carries no fields we read. */
function ignoreForms(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, _body, done) => {
      done(null, {});
    },
  );
}

export function createTokenRoutes(options: TokenRouterOptions) {
  const now = options.clock ?? (() => new Date());

  return (app: FastifyInstance): void => {
    ignoreForms(app);
    const typed = app.withTypeProvider<ZodTypeProvider>();
    const audits = [...new Set([...handlers.values()].flatMap((handler) => handler.audits))];
    const config = {
      auth: 'public',
      // Cancelling and opting out must keep working in a read-only organization (patient
      // protective); the router refuses the rest per kind.
      readOnly: 'patient_protective',
      rateLimit: { max: 30, timeWindow: 60_000 },
    } as const;

    async function respond(
      request: FastifyRequest<{ Params: { token: string } }>,
      reply: FastifyReply,
      act: boolean,
    ): Promise<FastifyReply> {
      const host = request.hostContext;
      if (host?.kind !== 'tenant') return denied(request, reply);
      const tenantId = host.tenant.id;
      const active = host.tenant.status === 'active';
      const { token } = request.params;

      const outcome = await options.withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
        const organizationName = await options.organizationName(tx);
        // Every registered kind is asked, even after a hit: the work does not depend on the answer.
        let found: { kind: TokenKind; subjectId: string; payload: Record<string, unknown> } | null =
          null;
        for (const kind of registeredTokenKinds()) {
          const hit = await options.tokens.inspect(tx, kind, token);
          if (hit && found === null) found = { kind, ...hit };
        }
        const handler = found ? handlers.get(found.kind) : undefined;
        if (!found || !handler) return { organizationName, page: INVALID };
        if (!active && !handler.allowedWhenReadOnly) return { organizationName, page: READ_ONLY };

        const context: TokenContext = {
          tx,
          tenantId,
          now: now(),
          kind: found.kind,
          subjectId: found.subjectId,
          payload: found.payload,
          actor: request.auditActor,
          redeem: async () => (await options.tokens.redeem(tx, found.kind, token)) !== null,
        };
        const page = act ? await handler.perform(context) : await handler.describe(context);
        return { organizationName, page: page ?? INVALID };
      });

      const { status = 200, ...model } = outcome.page;
      return (
        reply
          .code(status)
          .header('content-security-policy', PAGE_CONTENT_SECURITY_POLICY)
          .header('x-robots-tag', 'noindex, nofollow')
          // The button posts to the same address; `no-referrer` would make the browser send
          // `Origin: null`, which the origin check refuses. The link never leaves its own origin.
          .header('referrer-policy', 'same-origin')
          .type('text/html; charset=utf-8')
          .send(renderTokenPage({ ...model, organizationName: outcome.organizationName }))
      );
    }

    typed.get('/public/t/:token', { config, schema: { params: Params } }, (request, reply) =>
      respond(request, reply, false),
    );
    typed.post(
      '/public/t/:token',
      {
        config: { ...config, audits: audits.length === 0 ? 'none' : audits },
        schema: { params: Params },
      },
      (request, reply) => respond(request, reply, true),
    );
  };
}
