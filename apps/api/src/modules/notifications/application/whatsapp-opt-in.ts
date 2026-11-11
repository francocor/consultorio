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
 *
 * The link exists for EVERY submission that ticked the box, whoever the document belongs to (judgment
 * day round 2, finding A1): an email that carried it only when the form had created the patient
 * would tell the visitor that a document was already on file. So the token belongs to the
 * SUBMISSION, not to a patient. It remembers the patient and whether this submission created them;
 * when it is followed, the opt-in is recorded only if it did, and in any other case reception is
 * asked to look, and the patient sees the same page.
 */

/** What the token of a submission remembers (its payload). */
export interface OptInRequest {
  /** The record the submission ended on, or none (an entry that was refused). */
  patientId: string | null;
  /** True when this submission created that record: only then may following the link opt in. */
  created: boolean;
  /** The appointment of a booking, for the item reception is asked to look at. */
  appointmentId?: string | undefined;
  locationId?: string | undefined;
}

export interface WhatsappOptInEmail {
  tenant: { id: string; slug: string; isDemo: boolean };
  /** The address the visitor verified with a code. */
  to: string;
  patientName: string;
  organizationName: string;
  token: string;
}

export interface WhatsappOptInRequests {
  /** In the transaction that registers the submission: prepares the link of that submission. */
  request(
    tx: Tx,
    input: OptInRequest & { submissionId: string; at: Date },
  ): Promise<{ token: string }>;
  /** After that transaction committed: emails the link. */
  send(input: WhatsappOptInEmail): Promise<void>;
}

const DAY_MS = 86_400_000;

/** The payload of the token of a submission. */
export function optInPayload(input: OptInRequest): Record<string, unknown> {
  return {
    patientId: input.patientId,
    created: input.created,
    ...(input.appointmentId === undefined ? {} : { appointmentId: input.appointmentId }),
    ...(input.locationId === undefined ? {} : { locationId: input.locationId }),
  };
}

export function createWhatsappOptInRequests(deps: {
  tokens: ActionTokens;
  origins: PublicOrigins;
  /** Routed by organization: a demonstration organization never reaches a real mail server. */
  email: EmailSender;
}): WhatsappOptInRequests {
  return {
    async request(tx, input) {
      const issued = await deps.tokens.issue(tx, {
        kind: 'whatsapp_opt_in',
        subjectId: input.submissionId,
        payload: optInPayload(input),
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
