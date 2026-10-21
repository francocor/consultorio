import { and, eq, isNull } from 'drizzle-orm';

import { signupPending } from '../../../../db/schema/signup.js';
import { tenant } from '../../../../db/schema/tenant.js';
import { evenOut } from '../../../../platform/db/even-work.js';
import { SYSTEM_USER_ID, type WithTenant } from '../../../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../../../platform/http/public-origin.js';
import type { EmailSender } from '../../../../platform/mail/email-sender.js';
import { TOKEN_KIND_REGISTRY, type ActionTokens } from '../../../../platform/tokens/index.js';

import { renderVerificationEmail } from './mail.js';
import { EVEN_WORK } from './service.js';

/** The path of the page of the web app that follows the link (`features/onboarding/signup`). */
export const VERIFY_PATH = '/signup/verify';

/**
 * A link sent less than this long ago is still the owner's: a manual request for a new one does not
 * replace it. The token is stored hashed, so the same one cannot be sent again; the owner waits for
 * the email that is already on its way, and a third party who types their address cannot rotate it
 * out from under them (JD-S6 R2-6).
 */
export const RESEND_COOLDOWN_MS = 30 * 60_000;

/** The most times the verification email is sent on its own; the visitor can ask for more. */
export const MAX_AUTOMATIC_SENDS = 5;

export interface VerificationMailerDeps {
  withTenant: WithTenant;
  tokens: ActionTokens;
  email: EmailSender;
  /** Where emailed links point (the organization's own address), never the Host of a request. */
  origins: PublicOrigins;
  clock: () => Date;
}

export interface VerificationMailer {
  /**
   * Sends the verification link of a pending signup, with a fresh token that replaces any earlier
   * one. `manual` is a visitor asking again: it starts the count of automatic attempts over. Does
   * nothing when the organization has no pending signup (it was verified, or purged).
   *
   * Three short steps and no transaction open while the provider answers: the token and the mark of
   * the attempt are written first, the email goes out, and only then is it marked as sent. If the
   * email cannot be sent the error is thrown AFTER the attempt was recorded, and the retry of the
   * worker (`app.signup_unsent`) picks the signup up again with a backoff.
   */
  issueAndSend(tenantId: string, options: { manual: boolean }): Promise<void>;
}

export function createVerificationMailer(deps: VerificationMailerDeps): VerificationMailer {
  const { withTenant, tokens } = deps;

  return {
    async issueAndSend(tenantId, options) {
      const prepared = await withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
        const [row] = await tx
          .select()
          .from(signupPending)
          .where(isNull(signupPending.verifiedAt))
          .for('update');
        if (!row) return null;
        const sentAt = row.verificationSentAt;
        if (
          options.manual &&
          sentAt !== null &&
          deps.clock().getTime() - sentAt.getTime() < RESEND_COOLDOWN_MS
        ) {
          // The live link is young: nothing is replaced and nothing is sent. The same statements are
          // sent to the database as when a link is issued, so the two cannot be told apart.
          await evenOut(tx, EVEN_WORK.prepare - 1);
          return 'cooling' as const;
        }
        await tokens.revokeForSubject(tx, 'signup_verification', row.id);
        const issued = await tokens.issue(tx, { kind: 'signup_verification', subjectId: row.id });
        await tx
          .update(signupPending)
          .set({
            sendAttempts: options.manual ? 1 : row.sendAttempts + 1,
            lastSendAttemptAt: deps.clock(),
          })
          .where(eq(signupPending.id, row.id));
        const [organization] = await tx
          .select({ slug: tenant.slug, theme: tenant.theme })
          .from(tenant);
        if (!organization) return null;
        const name = organization.theme['displayName'];
        return {
          signupId: row.id,
          to: row.ownerEmail,
          ownerName: row.ownerName,
          organizationName: typeof name === 'string' && name !== '' ? name : organization.slug,
          slug: organization.slug,
          token: issued.token,
        };
      });
      if (prepared === 'cooling') {
        await withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) => evenOut(tx, EVEN_WORK.mark));
        return;
      }
      if (!prepared) return;

      const rendered = renderVerificationEmail({
        ownerName: prepared.ownerName,
        organizationName: prepared.organizationName,
        link: `${deps.origins(prepared.slug)}${VERIFY_PATH}?token=${prepared.token}`,
        expiresInHours: TOKEN_KIND_REGISTRY.signup_verification.ttlMs / 3_600_000,
      });
      await deps.email.send({
        to: prepared.to,
        tenant: { id: tenantId, isDemo: false },
        ...rendered,
      });

      await withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) =>
        tx
          .update(signupPending)
          .set({ verificationSentAt: deps.clock() })
          .where(and(eq(signupPending.id, prepared.signupId), isNull(signupPending.verifiedAt))),
      );
    },
  };
}
