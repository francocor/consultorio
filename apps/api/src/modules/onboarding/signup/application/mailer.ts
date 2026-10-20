import { and, eq, isNull } from 'drizzle-orm';

import { signupPending } from '../../../../db/schema/signup.js';
import { tenant } from '../../../../db/schema/tenant.js';
import { SYSTEM_USER_ID, type WithTenant } from '../../../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../../../platform/http/public-origin.js';
import type { EmailSender } from '../../../../platform/mail/email-sender.js';
import { TOKEN_KIND_REGISTRY, type ActionTokens } from '../../../../platform/tokens/index.js';

import { renderVerificationEmail } from './mail.js';

/** The path of the page of the web app that follows the link (`features/onboarding/signup`). */
export const VERIFY_PATH = '/signup/verify';

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
