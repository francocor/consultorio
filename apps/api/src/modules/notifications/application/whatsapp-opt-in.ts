import type { Tx } from '../../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { TOKEN_KIND_REGISTRY, type ActionTokens } from '../../../platform/tokens/index.js';
import { renderOptInRequestEmail } from '../assets/es-AR/opt-in-email.js';
import { firstNameOf } from '../domain/content.js';

import { TOKEN_PATH } from './links.js';

/**
 * Asking a patient to accept WhatsApp when the number was typed into a public form (decision D22).
 * Nobody verified that number, so the choice on the form is only a request: the patient gets a link
 * at the address that WAS verified, and the opt-in exists once they follow it. Until then the
 * patient's messages go by email (a patient with no opt-in is never written to over WhatsApp).
 */

export interface WhatsappOptInEmail {
  tenant: { id: string; slug: string; isDemo: boolean };
  /** The address the visitor verified with a code. */
  to: string;
  patientName: string;
  organizationName: string;
  token: string;
}

export interface WhatsappOptInRequests {
  /** In the transaction that registers the patient: a newer request replaces the older link. */
  request(tx: Tx, input: { patientId: string; at: Date }): Promise<{ token: string }>;
  /** After that transaction committed: emails the link. */
  send(input: WhatsappOptInEmail): Promise<void>;
}

const DAY_MS = 86_400_000;

export function createWhatsappOptInRequests(deps: {
  tokens: ActionTokens;
  origins: PublicOrigins;
  /** Routed by organization: a demonstration organization never reaches a real mail server. */
  email: EmailSender;
}): WhatsappOptInRequests {
  return {
    async request(tx, input) {
      await deps.tokens.revokeForSubject(tx, 'whatsapp_opt_in', input.patientId);
      const issued = await deps.tokens.issue(tx, {
        kind: 'whatsapp_opt_in',
        subjectId: input.patientId,
      });
      return { token: issued.token };
    },
    async send(input) {
      const message = renderOptInRequestEmail({
        organizationName: input.organizationName,
        patientName: firstNameOf(input.patientName),
        link: `${deps.origins(input.tenant.slug)}${TOKEN_PATH}${input.token}`,
        expiresInDays: Math.round(TOKEN_KIND_REGISTRY.whatsapp_opt_in.ttlMs / DAY_MS),
      });
      await deps.email.send({
        to: input.to,
        ...message,
        tenant: { id: input.tenant.id, isDemo: input.tenant.isDemo },
      });
    },
  };
}
