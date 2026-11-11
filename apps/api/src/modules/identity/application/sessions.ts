import { createHash, randomBytes } from 'node:crypto';

import type { Role, SessionScope } from '@consultorio/contracts';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';

import { membership, session } from '../../../db/schema/identity.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * Staff sessions end after 30 minutes without use and after 7 days whatever the use (ADR-004).
 * Thirty minutes of inactivity is the Level 2 answer of ASVS 3.3.2 (security review: the earlier
 * 12 hours was accepted only until the owner decided). Any request counts as use, so a person
 * working in the app never notices it.
 */
export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 3_600_000;

/** `last_seen_at` is only rewritten when it is older than this, to avoid a write per request. */
const TOUCH_AFTER_MS = 60_000;

export type SessionRevokeReason =
  | 'logout'
  | 'revoked_by_user'
  | 'password_changed'
  | 'password_reset'
  | 'privilege_changed'
  | 'deactivated'
  | 'rotated';

/** A 256-bit random token, base64url without padding (43 characters). */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database stores: the SHA-256 of the token, never the token. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type SessionVerdict = 'active' | 'revoked' | 'idle_expired' | 'absolute_expired';

/** Whether a session may still be used at `now`. Pure: the clock is a parameter. */
export function sessionVerdict(
  state: { revokedAt: Date | null; lastSeenAt: Date; expiresAt: Date },
  now: Date,
): SessionVerdict {
  if (state.revokedAt !== null) return 'revoked';
  if (now.getTime() >= state.expiresAt.getTime()) return 'absolute_expired';
  if (now.getTime() - state.lastSeenAt.getTime() >= SESSION_IDLE_MS) return 'idle_expired';
  return 'active';
}

export interface IssueSessionInput {
  tenantId: string;
  userId: string;
  membershipId: string;
  scope?: SessionScope;
  ip?: string | null;
  userAgent?: string | null;
}

export interface IssuedSession {
  sessionId: string;
  /** The raw token. It exists only here: hand it to the cookie and forget it. */
  token: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  membershipId: string;
  tenantId: string;
  roles: readonly Role[];
  scope: SessionScope;
  expiresAt: Date;
}

export interface SessionListEntry {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface SessionService {
  issue(tx: Tx, input: IssueSessionInput): Promise<IssuedSession>;
  /** The live session behind a token on the transaction's tenant, or null. */
  resolve(tx: Tx, token: string): Promise<ResolvedSession | null>;
  /** True when this call ended the session; false when it was already over or not visible. */
  revoke(tx: Tx, sessionId: string, reason: SessionRevokeReason): Promise<boolean>;
  /**
   * Ends a session and starts another for the same user and membership. The new one keeps the
   * scope unless `scope` says otherwise (an enrollment-only session becomes a full one).
   */
  rotate(
    tx: Tx,
    sessionId: string,
    reason: SessionRevokeReason,
    options?: { scope?: SessionScope },
  ): Promise<IssuedSession>;
  /** Ends the user's sessions on this tenant, except one. Returns how many were ended. */
  revokeAllForUser(
    tx: Tx,
    userId: string,
    reason: SessionRevokeReason,
    exceptSessionId?: string,
  ): Promise<number>;
  /**
   * Ends the sessions of the acting user in EVERY organization (a password change). The
   * transaction must be acting as that user; the database function refuses anything else.
   */
  revokeEverywhere(
    tx: Tx,
    userId: string,
    reason: SessionRevokeReason,
    exceptSessionId?: string,
  ): Promise<number>;
  listForUser(tx: Tx, userId: string, currentSessionId: string | null): Promise<SessionListEntry[]>;
}

export function createSessionService(options: { clock?: () => Date } = {}): SessionService {
  const clock = options.clock ?? (() => new Date());

  const issue: SessionService['issue'] = async (tx, input) => {
    const issuedAt = clock();
    const expiresAt = new Date(issuedAt.getTime() + SESSION_ABSOLUTE_MS);
    const token = newSessionToken();
    const [row] = await tx
      .insert(session)
      .values({
        tenantId: input.tenantId,
        userId: input.userId,
        membershipId: input.membershipId,
        tokenHash: hashSessionToken(token),
        scope: input.scope ?? 'full',
        lastSeenAt: issuedAt,
        expiresAt,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      })
      .returning({ id: session.id });
    if (!row) throw new Error('session insert returned no row');
    return { sessionId: row.id, token, issuedAt, expiresAt };
  };

  const revoke: SessionService['revoke'] = async (tx, sessionId, reason) => {
    const rows = await tx
      .update(session)
      .set({ revokedAt: clock(), revokedReason: reason })
      .where(and(eq(session.id, sessionId), isNull(session.revokedAt)))
      .returning({ id: session.id });
    return rows.length > 0;
  };

  return {
    issue,
    revoke,

    async resolve(tx, token) {
      const now = clock();
      const [row] = await tx
        .select({
          sessionId: session.id,
          userId: session.userId,
          membershipId: session.membershipId,
          tenantId: session.tenantId,
          scope: session.scope,
          lastSeenAt: session.lastSeenAt,
          expiresAt: session.expiresAt,
          revokedAt: session.revokedAt,
          roles: membership.roles,
          membershipStatus: membership.status,
        })
        .from(session)
        .innerJoin(
          membership,
          and(eq(membership.tenantId, session.tenantId), eq(membership.id, session.membershipId)),
        )
        .where(eq(session.tokenHash, hashSessionToken(token)));

      if (!row || row.membershipStatus !== 'active') return null;
      if (sessionVerdict(row, now) !== 'active') return null;

      if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_AFTER_MS) {
        await tx.update(session).set({ lastSeenAt: now }).where(eq(session.id, row.sessionId));
      }
      return {
        sessionId: row.sessionId,
        userId: row.userId,
        membershipId: row.membershipId,
        tenantId: row.tenantId,
        roles: row.roles as Role[],
        scope: row.scope as SessionScope,
        expiresAt: row.expiresAt,
      };
    },

    async rotate(tx, sessionId, reason, rotateOptions = {}) {
      const [current] = await tx.select().from(session).where(eq(session.id, sessionId));
      if (!current) throw new Error('session not found');
      await revoke(tx, sessionId, reason);
      return issue(tx, {
        tenantId: current.tenantId,
        userId: current.userId,
        membershipId: current.membershipId,
        scope: rotateOptions.scope ?? (current.scope as SessionScope),
        ip: current.ip,
        userAgent: current.userAgent,
      });
    },

    async revokeAllForUser(tx, userId, reason, exceptSessionId) {
      const rows = await tx
        .update(session)
        .set({ revokedAt: clock(), revokedReason: reason })
        .where(
          and(
            eq(session.userId, userId),
            isNull(session.revokedAt),
            exceptSessionId === undefined ? undefined : ne(session.id, exceptSessionId),
          ),
        )
        .returning({ id: session.id });
      return rows.length;
    },

    async revokeEverywhere(tx, userId, reason, exceptSessionId) {
      const result = await tx.execute<{ count: number }>(
        sql`select app.revoke_user_sessions(${userId}::uuid, ${reason}, ${clock().toISOString()}::timestamptz, ${exceptSessionId ?? null}::uuid) as count`,
      );
      return result.rows[0]?.count ?? 0;
    },

    async listForUser(tx, userId, currentSessionId) {
      const rows = await tx
        .select()
        .from(session)
        .where(and(eq(session.userId, userId), isNull(session.revokedAt)))
        .orderBy(desc(session.createdAt), desc(session.id));
      const now = clock();
      return rows
        .filter((row) => sessionVerdict(row, now) === 'active')
        .map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          lastSeenAt: row.lastSeenAt,
          expiresAt: row.expiresAt,
          ip: row.ip,
          userAgent: row.userAgent,
          current: row.id === currentSessionId,
        }));
    },
  };
}
