import { and, eq, sql } from 'drizzle-orm';

import { membership, userAccount } from '../../../db/schema/identity.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { RateLimitStore } from '../../../platform/http/rate-limit.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { renderPasswordResetEmail } from '../../../platform/mail/templates.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import { TOKEN_KIND_REGISTRY } from '../../../platform/tokens/kinds.js';
import { readOrganizationName } from '../../tenancy/index.js';
import type { PasswordValidator } from '../domain/password-policy.js';
import type { PasswordHasher } from '../infrastructure/argon2.js';

import type { Lockout } from './lockout.js';
import { passwordFieldErrors } from './password-errors.js';
import type { SessionService } from './sessions.js';

const HOUR = 3_600_000;
/** At most this many reset emails per account per hour, however often they are requested. */
export const RESET_EMAILS_PER_HOUR = 3;

export interface ResetLinkContext {
  tenantId: string;
  /** A demo organization's email never goes through the real provider. */
  isDemo: boolean;
  /** Name of the organization as the email shows it. */
  organizationName: string;
  /** `https://{tenant host}`: the link opens the web app on the tenant's own host. */
  baseUrl: string;
  actor: AuditActor;
}

export interface PasswordReset {
  /**
   * A reset request made with an email address only. It does the work whether or not the account
   * exists and returns nothing, so what the caller can observe never depends on it. Run it after
   * the response (see `BackgroundTasks`).
   */
  requestByEmail(context: ResetLinkContext, email: string): Promise<void>;
  /** A reset an administrator triggered for a member: sends the email, sets nothing. */
  requestForMember(context: ResetLinkContext, userId: string): Promise<'sent' | 'not_a_member'>;
  /**
   * Sets a new password with the emailed token. The token is only spent if the password passes
   * the policy. Ends every session of the user, lifts a lock, and signs nobody in.
   */
  complete(input: {
    tenantId: string;
    token: string;
    password: string;
    actor: AuditActor;
  }): Promise<void>;
}

export interface PasswordResetDeps {
  withTenant: WithTenant;
  tokens: ActionTokens;
  sessions: SessionService;
  hasher: PasswordHasher;
  validator: PasswordValidator;
  lockout: Lockout;
  email: EmailSender;
  /** Counts the emails sent per account. */
  limits: RateLimitStore;
  clock?: () => Date;
}

/** The path of the web app screen where the new password is chosen. */
export const PASSWORD_RESET_PATH = '/reset-password';

interface AccountRow extends Record<string, unknown> {
  id: string;
}

export function createPasswordReset(deps: PasswordResetDeps): PasswordReset {
  const clock = deps.clock ?? (() => new Date());

  /** Issues the link for a member of the tenant and sends it. Nothing is sent to a non-member. */
  async function issueAndSend(
    context: ResetLinkContext,
    userId: string,
    triggeredBy: 'self' | 'admin',
    adminUserId?: string,
  ): Promise<'sent' | 'not_a_member'> {
    const prepared = await deps.withTenant({ tenantId: context.tenantId, userId }, async (tx) => {
      const [member] = await tx
        .select({ status: membership.status })
        .from(membership)
        .where(and(eq(membership.tenantId, context.tenantId), eq(membership.userId, userId)));
      if (member?.status !== 'active') return null;
      const [account] = await tx
        .select({ email: userAccount.email })
        .from(userAccount)
        .where(eq(userAccount.id, userId));
      if (!account) return null;

      // A newer link replaces the older ones.
      await deps.tokens.revokeForSubject(tx, 'password_reset', userId);
      const issued = await deps.tokens.issue(tx, { kind: 'password_reset', subjectId: userId });
      await audit(tx, {
        action: 'auth.password.reset_requested',
        outcome: 'allow',
        actor: {
          ...context.actor,
          userId: adminUserId ?? userId,
          actingRole: null,
        },
        resourceType: 'user',
        resourceId: userId,
        metadata: { triggeredBy },
      });
      // The name people know (its branding), not the slug of its address.
      const organizationName = (await readOrganizationName(tx)) || context.organizationName;
      return { email: account.email, token: issued.token, organizationName };
    });
    if (!prepared) return 'not_a_member';

    const link = `${context.baseUrl}${PASSWORD_RESET_PATH}?token=${prepared.token}`;
    await deps.email.send({
      to: prepared.email,
      tenant: { id: context.tenantId, isDemo: context.isDemo },
      ...renderPasswordResetEmail({
        organizationName: prepared.organizationName,
        link,
        expiresInMinutes: TOKEN_KIND_REGISTRY.password_reset.ttlMs / 60_000,
      }),
    });
    return 'sent';
  }

  return {
    async requestByEmail(context, email) {
      const found = await deps.withTenant(
        { tenantId: context.tenantId, userId: SYSTEM_USER_ID },
        async (tx) => {
          const result = await tx.execute<AccountRow>(
            sql`select id from app.lookup_user_for_login(${email.trim()})`,
          );
          return result.rows[0]?.id ?? null;
        },
      );
      if (found === null) return;

      const { count } = await deps.limits.hit(`reset-email|${context.tenantId}|${found}`, HOUR);
      if (count > RESET_EMAILS_PER_HOUR) return;
      await issueAndSend(context, found, 'self');
    },

    async requestForMember(context, userId) {
      return issueAndSend(context, userId, 'admin', context.actor.userId ?? userId);
    },

    async complete(input) {
      // 1. Look at the link without spending it: the password is checked against the account's
      // email, and a weak password must not burn the link.
      const seen = await deps.withTenant(
        { tenantId: input.tenantId, userId: SYSTEM_USER_ID },
        (tx) => deps.tokens.inspect(tx, 'password_reset', input.token),
      );
      if (!seen) throw new AppError('bad_request');
      const userId = seen.subjectId;

      const email = await deps.withTenant({ tenantId: input.tenantId, userId }, async (tx) => {
        const [row] = await tx
          .select({ email: userAccount.email })
          .from(userAccount)
          .where(eq(userAccount.id, userId));
        return row?.email;
      });
      if (email === undefined) throw new AppError('bad_request');

      const verdict = await deps.validator.validate(input.password, { email });
      if (!verdict.ok) throw new AppError('validation_failed', passwordFieldErrors(verdict.issues));
      const passwordHash = await deps.hasher.hash(input.password);

      // 2. Spend the link and change everything together.
      await deps.withTenant({ tenantId: input.tenantId, userId }, async (tx) => {
        const redeemed = await deps.tokens.redeem(tx, 'password_reset', input.token);
        if (!redeemed) throw new AppError('bad_request');

        const now = clock();
        const actor: AuditActor = { ...input.actor, userId, actingRole: null };
        const [before] = await tx
          .select({ lockedUntil: userAccount.lockedUntil })
          .from(userAccount)
          .where(eq(userAccount.id, userId));
        const wasLocked =
          before?.lockedUntil !== null &&
          before?.lockedUntil !== undefined &&
          before.lockedUntil.getTime() > now.getTime();

        await tx
          .update(userAccount)
          .set({ passwordHash, passwordChangedAt: now })
          .where(eq(userAccount.id, userId));
        // Recovering the account with proof of the email is an authorized way past a lock.
        await deps.lockout.reset(tx, userId);
        if (wasLocked) {
          await audit(tx, {
            action: 'auth.account.unlocked',
            outcome: 'allow',
            actor,
            reason: 'password_reset',
          });
        }
        await deps.sessions.revokeEverywhere(tx, userId, 'password_reset');
        await audit(tx, {
          action: 'auth.password.reset_completed',
          outcome: 'allow',
          actor,
          resourceType: 'user',
          resourceId: userId,
        });
      });
    },
  };
}
