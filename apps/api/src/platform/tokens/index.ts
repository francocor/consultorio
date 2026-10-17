import { createHash, randomBytes } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { actionToken } from '../../db/schema/action-token.js';
import type { Tx } from '../db/tenant-context.js';

import { TOKEN_KIND_REGISTRY, isEnabledKind, type TokenKind } from './kinds.js';

export { TOKEN_KINDS, TOKEN_KIND_REGISTRY } from './kinds.js';
export type { TokenKind } from './kinds.js';

/** A 256-bit random token in unpadded base64url: 43 characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashActionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssueTokenInput {
  kind: TokenKind;
  /** What the link is about (a user for resets and invitations). */
  subjectId: string;
  /** Small, non-secret facts of the flow, such as the invited email and roles. */
  payload?: Record<string, unknown>;
  /** Binds the token to one session; required by session-bound kinds. */
  sessionId?: string;
  /** Shortens the lifetime of the kind. It can never extend it. */
  ttlMs?: number;
  /** Lowers the number of uses of the kind. It can never raise it. */
  maxUses?: number;
}

export interface IssuedToken {
  id: string;
  /** The raw token. It exists only here: put it in the email and forget it. */
  token: string;
  expiresAt: Date;
}

export interface RedeemedToken {
  id: string;
  kind: TokenKind;
  subjectId: string;
  payload: Record<string, unknown>;
  /** Uses left after this one. */
  usesLeft: number;
}

export interface ActionTokens {
  issue(tx: Tx, input: IssueTokenInput): Promise<IssuedToken>;
  /**
   * Consumes one use of a token. One atomic UPDATE checks kind, expiry, number of uses,
   * revocation and session binding, so two simultaneous redemptions of a single-use token cannot
   * both succeed. Every way of failing returns the same `null`.
   */
  redeem(
    tx: Tx,
    kind: TokenKind,
    token: string,
    options?: { sessionId?: string },
  ): Promise<RedeemedToken | null>;
  /** Looks at a live token without using it, to show what a link is about before it is spent. */
  inspect(
    tx: Tx,
    kind: TokenKind,
    token: string,
  ): Promise<Pick<RedeemedToken, 'subjectId' | 'payload'> | null>;
  /** Cancels the outstanding tokens of a kind for a subject (a newer reset replaces older ones). */
  revokeForSubject(tx: Tx, kind: TokenKind, subjectId: string): Promise<number>;
}

export function createActionTokens(options: { clock?: () => Date } = {}): ActionTokens {
  const clock = options.clock ?? (() => new Date());

  return {
    async issue(tx, input) {
      const spec = TOKEN_KIND_REGISTRY[input.kind];
      if (!isEnabledKind(input.kind)) {
        throw new Error(`Token kind "${input.kind}" is not enabled`);
      }
      if (spec.sessionBound && input.sessionId === undefined) {
        throw new Error(`Token kind "${input.kind}" must be bound to a session`);
      }

      const ttlMs = Math.min(input.ttlMs ?? spec.ttlMs, spec.ttlMs);
      const maxUses = Math.min(input.maxUses ?? spec.maxUses, spec.maxUses);
      const expiresAt = new Date(clock().getTime() + ttlMs);
      const token = randomBytes(32).toString('base64url');

      const [row] = await tx
        .insert(actionToken)
        .values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          kind: input.kind,
          tokenHash: hashActionToken(token),
          subjectId: input.subjectId,
          sessionId: input.sessionId ?? null,
          payload: input.payload ?? {},
          expiresAt,
          maxUses,
        })
        .returning({ id: actionToken.id });
      if (!row) throw new Error('token insert returned no row');
      return { id: row.id, token, expiresAt };
    },

    async redeem(tx, kind, token, redeemOptions = {}) {
      if (!TOKEN_PATTERN.test(token)) return null;
      const now = clock();
      const [row] = await tx
        .update(actionToken)
        .set({ uses: sql`${actionToken.uses} + 1`, usedAt: now })
        .where(
          and(
            eq(actionToken.tokenHash, hashActionToken(token)),
            eq(actionToken.kind, kind),
            isNull(actionToken.revokedAt),
            sql`${actionToken.uses} < ${actionToken.maxUses}`,
            sql`${actionToken.expiresAt} > ${now.toISOString()}::timestamptz`,
            // A token bound to a session only works for that session; an unbound one for anyone.
            redeemOptions.sessionId === undefined
              ? isNull(actionToken.sessionId)
              : sql`(${actionToken.sessionId} is null or ${actionToken.sessionId} = ${redeemOptions.sessionId}::uuid)`,
          ),
        )
        .returning({
          id: actionToken.id,
          subjectId: actionToken.subjectId,
          payload: actionToken.payload,
          uses: actionToken.uses,
          maxUses: actionToken.maxUses,
        });
      if (!row) return null;
      return {
        id: row.id,
        kind,
        subjectId: row.subjectId,
        payload: row.payload,
        usesLeft: row.maxUses - row.uses,
      };
    },

    async inspect(tx, kind, token) {
      if (!TOKEN_PATTERN.test(token)) return null;
      const [row] = await tx
        .select({ subjectId: actionToken.subjectId, payload: actionToken.payload })
        .from(actionToken)
        .where(
          and(
            eq(actionToken.tokenHash, hashActionToken(token)),
            eq(actionToken.kind, kind),
            isNull(actionToken.revokedAt),
            sql`${actionToken.uses} < ${actionToken.maxUses}`,
            sql`${actionToken.expiresAt} > ${clock().toISOString()}::timestamptz`,
          ),
        );
      return row ?? null;
    },

    async revokeForSubject(tx, kind, subjectId) {
      const rows = await tx
        .update(actionToken)
        .set({ revokedAt: clock() })
        .where(
          and(
            eq(actionToken.kind, kind),
            eq(actionToken.subjectId, subjectId),
            isNull(actionToken.revokedAt),
            sql`${actionToken.uses} < ${actionToken.maxUses}`,
          ),
        )
        .returning({ id: actionToken.id });
      return rows.length;
    },
  };
}
