import { eq } from 'drizzle-orm';

import { consentRequest } from '../../../db/schema/consent.js';
import { tenant } from '../../../db/schema/tenant.js';
import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { loadNoticeRecipient } from '../../notifications/index.js';
import { readOrganizationName } from '../../tenancy/index.js';
import { renderConsentRequestEmail } from '../domain/request-email.js';

export type NoticeOutcome = 'sent' | 'not_sent' | 'not_needed';

export interface ConsentNotice {
  /**
   * Tells the patient a consent waits for their signature, when it is to be signed in the portal.
   * Called after the request committed: a failure of the provider is the answer `not_sent` and
   * never undoes the request, and the staff are told so they can reach the patient another way.
   */
  notifyRequest(tenantId: string, requestId: string): Promise<NoticeOutcome>;
}

/**
 * The notice of a consent request (task 5.15). The channel policy of notifications decides the
 * channel: kind `consent_request` is email only, so an opt-out, a missing address or one that
 * failed for good leaves nobody to write to. The message carries no template title (see
 * `renderConsentRequestEmail`) and links to the authenticated portal.
 */
export function createConsentNotice(deps: {
  withTenant: WithTenant;
  email: EmailSender;
  origins: PublicOrigins;
}): ConsentNotice {
  return {
    async notifyRequest(tenantId, requestId) {
      try {
        return await deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
          const [request] = await tx
            .select({ patientId: consentRequest.patientId, method: consentRequest.method })
            .from(consentRequest)
            .where(eq(consentRequest.id, requestId));
          if (request?.method !== 'portal') return 'not_needed' as const;

          const recipient = await loadNoticeRecipient(tx, request.patientId, 'consent_request');
          if (!recipient?.email) return 'not_sent' as const;

          const [organization] = await tx
            .select({ slug: tenant.slug, isDemo: tenant.isDemo })
            .from(tenant)
            .where(eq(tenant.id, tenantId));
          if (!organization) return 'not_sent' as const;

          const rendered = renderConsentRequestEmail({
            organizationName: await readOrganizationName(tx),
            givenNames: recipient.givenNames,
            portalUrl: `${deps.origins(organization.slug)}/portal`,
          });
          await deps.email.send({
            to: recipient.email,
            ...rendered,
            tenant: { id: tenantId, isDemo: organization.isDemo },
          });
          return 'sent' as const;
        });
      } catch {
        // The provider failed: the request stands and the staff are told the patient was not reached.
        return 'not_sent';
      }
    },
  };
}
