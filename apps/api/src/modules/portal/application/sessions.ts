import { createHash, randomBytes } from 'node:crypto';

import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';

import { portalIdentity, portalLink, portalSession } from '../../../db/schema/portal.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { PORTAL_SESSION_ABSOLUTE_MS, portalSessionVerdict } from '../domain/session-rules.js';

import { linkInForce, organizationToday } from './link-access.js';

/** `last_seen_at` is only rewritten when it is older than this, to avoid a write per request. */
const TOUCH_AFTER_MS = 60_000;

export type PortalSessionRevokeReason =
  | 'logout'
  | 'revoked_by_patient'
  | 'revoked_by_staff'
  | 'deactivated'
  | 'email_changed'
  | 'link_revoked';

/** A 256-bit random token, base64url without padding (43 characters). */
export function newPortalSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database stores: the SHA-256 of the token, never the token. */
export function hashPortalSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedPortalSession {
  sessionId: string;
  /** The raw token. It exists only here: hand it to the cookie and forget it. */
  token: string;
  expiresAt: Date;
}

export interface ResolvedPortalSession {
  sessionId: string;
  tenantId: string;
  identityId: string;
  /** The subject the person picked, or null until they pick one (or when it no longer holds). */
  linkId: string | null;
  expiresAt: Date;
}

export interface PortalSessionListEntry {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  current: boolean;
}

export interface PortalSessions {
  issue(
    tx: Tx,
    input: {
      identityId: string;
      selectedLinkId: string | null;
      now: Date;
      ip: string | null;
      userAgent: string | null;
    },
  ): Promise<IssuedPortalSession>;
  /** The live session behind a token on the transaction's tenant, or null. */
  resolve(tx: Tx, token: string, now: Date): Promise<ResolvedPortalSession | null>;
  /** True when this call ended the session. */
  revoke(
    tx: Tx,
    sessionId: string,
    reason: PortalSessionRevokeReason,
    now: Date,
    by?: string,
  ): Promise<boolean>;
  /** Ends the sessions of an identity, except one. Returns how many it ended. */
  revokeAllForIdentity(
    tx: Tx,
    identityId: string,
    reason: PortalSessionRevokeReason,
    now: Date,
    options?: { exceptSessionId?: string; by?: string },
  ): Promise<number>;
  /** Picks the subject of what the session reads (already checked to belong to the identity). */
  selectLink(tx: Tx, sessionId: string, linkId: string | null): Promise<void>;
  list(
    tx: Tx,
    identityId: string,
    currentSessionId: string | null,
    now: Date,
  ): Promise<PortalSessionListEntry[]>;
}

export function createPortalSessions(): PortalSessions {
  const revoke: PortalSessions['revoke'] = async (tx, sessionId, reason, now, by) => {
    const rows = await tx
      .update(portalSession)
      .set({
        revokedAt: now,
        revokedReason: reason,
        ...(by === undefined ? {} : { revokedBy: by }),
      })
      .where(and(eq(portalSession.id, sessionId), isNull(portalSession.revokedAt)))
      .returning({ id: portalSession.id });
    return rows.length > 0;
  };

  return {
    revoke,

    async issue(tx, input) {
      const token = newPortalSessionToken();
      const expiresAt = new Date(input.now.getTime() + PORTAL_SESSION_ABSOLUTE_MS);
      const [row] = await tx
        .insert(portalSession)
        .values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          portalIdentityId: input.identityId,
          selectedLinkId: input.selectedLinkId,
          tokenHash: hashPortalSessionToken(token),
          lastSeenAt: input.now,
          expiresAt,
          ip: input.ip,
          userAgent: input.userAgent,
        })
        .returning({ id: portalSession.id });
      if (!row) throw new Error('portal session insert returned no row');
      return { sessionId: row.id, token, expiresAt };
    },

    async resolve(tx, token, now) {
      const [row] = await tx
        .select({
          sessionId: portalSession.id,
          tenantId: portalSession.tenantId,
          identityId: portalSession.portalIdentityId,
          linkId: portalSession.selectedLinkId,
          lastSeenAt: portalSession.lastSeenAt,
          expiresAt: portalSession.expiresAt,
          revokedAt: portalSession.revokedAt,
          identityStatus: portalIdentity.status,
        })
        .from(portalSession)
        .innerJoin(
          portalIdentity,
          and(
            eq(portalIdentity.tenantId, portalSession.tenantId),
            eq(portalIdentity.id, portalSession.portalIdentityId),
          ),
        )
        .where(eq(portalSession.tokenHash, hashPortalSessionToken(token)));
      if (row?.identityStatus !== 'active') return null;
      if (portalSessionVerdict(row, now) !== 'active') return null;

      if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_AFTER_MS) {
        await tx
          .update(portalSession)
          .set({ lastSeenAt: now })
          .where(eq(portalSession.id, row.sessionId));
      }
      // A link that was revoked or suspended since the person picked it is no subject any more.
      // Nor is a link whose dependent has reached the age of majority, whether or not the daily
      // review has suspended it yet (JD-S5 R1-S5-7).
      let linkId = row.linkId;
      if (linkId !== null) {
        const [link] = await tx
          .select({ status: portalLink.status, majorityReviewOn: portalLink.majorityReviewOn })
          .from(portalLink)
          .where(eq(portalLink.id, linkId));
        if (link?.status !== 'active' || !linkInForce(link, await organizationToday(tx, now))) {
          linkId = null;
        }
      }
      return {
        sessionId: row.sessionId,
        tenantId: row.tenantId,
        identityId: row.identityId,
        linkId,
        expiresAt: row.expiresAt,
      };
    },

    async revokeAllForIdentity(tx, identityId, reason, now, options = {}) {
      const rows = await tx
        .update(portalSession)
        .set({
          revokedAt: now,
          revokedReason: reason,
          ...(options.by === undefined ? {} : { revokedBy: options.by }),
        })
        .where(
          and(
            eq(portalSession.portalIdentityId, identityId),
            isNull(portalSession.revokedAt),
            options.exceptSessionId === undefined
              ? undefined
              : ne(portalSession.id, options.exceptSessionId),
          ),
        )
        .returning({ id: portalSession.id });
      return rows.length;
    },

    async selectLink(tx, sessionId, linkId) {
      await tx
        .update(portalSession)
        .set({ selectedLinkId: linkId })
        .where(eq(portalSession.id, sessionId));
    },

    async list(tx, identityId, currentSessionId, now) {
      const rows = await tx
        .select()
        .from(portalSession)
        .where(and(eq(portalSession.portalIdentityId, identityId), isNull(portalSession.revokedAt)))
        .orderBy(desc(portalSession.createdAt), desc(portalSession.id));
      return rows
        .filter((row) => portalSessionVerdict(row, now) === 'active')
        .map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          lastSeenAt: row.lastSeenAt,
          expiresAt: row.expiresAt,
          userAgent: row.userAgent,
          current: row.id === currentSessionId,
        }));
    },
  };
}
