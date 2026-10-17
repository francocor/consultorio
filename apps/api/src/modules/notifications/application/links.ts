import type { AppointmentMessageKind } from '@consultorio/contracts';

import type { Tx } from '../../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { ActionTokens, TokenKind } from '../../../platform/tokens/index.js';
import { isEnabledKind } from '../../../platform/tokens/kinds.js';
import type { EmailLinks } from '../assets/es-AR/email.js';

/** The path the token router answers (`platform/public/token-router.ts`). */
export const TOKEN_PATH = '/public/t/';

export interface LinkSubject {
  tenantSlug: string;
  appointmentId: string;
  patientId: string;
  /** The version of the appointment the links are for; a move revokes them. */
  appointmentVersion: number;
  startsAt: Date;
}

export interface LinkDeps {
  tokens: ActionTokens;
  origins: PublicOrigins;
  clock: () => Date;
}

/** The link that stops reminders by email for a patient (every email carries one). */
async function optOutLink(
  deps: LinkDeps,
  tx: Tx,
  input: { tenantSlug: string; patientId: string },
): Promise<string | undefined> {
  if (!isEnabledKind('notification_opt_out')) return undefined;
  const issued = await deps.tokens.issue(tx, {
    kind: 'notification_opt_out',
    subjectId: input.patientId,
    payload: { channel: 'email' },
  });
  return `${deps.origins(input.tenantSlug)}${TOKEN_PATH}${issued.token}`;
}

/**
 * The links of an email that offers a waitlist slot: the address that accepts or declines the offer
 * (built by the waitlist) and the way to stop receiving them.
 */
export async function issueOfferEmailLinks(
  deps: LinkDeps,
  tx: Tx,
  input: { tenantSlug: string; patientId: string; offerUrl: string },
): Promise<EmailLinks> {
  const optOutUrl = await optOutLink(deps, tx, input);
  return { offerUrl: input.offerUrl, ...(optOutUrl === undefined ? {} : { optOutUrl }) };
}

/**
 * Issues the single-purpose links of an email and builds their addresses from the configured
 * origin (never from a request). A kind whose capability is not enabled yet is left out, so the
 * message is simply written without that link. The links of an appointment expire when it starts.
 */
export async function issueEmailLinks(
  deps: LinkDeps,
  tx: Tx,
  kind: AppointmentMessageKind,
  subject: LinkSubject,
): Promise<EmailLinks> {
  const origin = deps.origins(subject.tenantSlug);
  const ttlMs = Math.max(subject.startsAt.getTime() - deps.clock().getTime(), 1);
  const url = (token: string) => `${origin}${TOKEN_PATH}${token}`;

  const appointmentLink = async (tokenKind: TokenKind): Promise<string | undefined> => {
    if (!isEnabledKind(tokenKind)) return undefined;
    const issued = await deps.tokens.issue(tx, {
      kind: tokenKind,
      subjectId: subject.appointmentId,
      payload: { patientId: subject.patientId, version: subject.appointmentVersion },
      ttlMs,
    });
    return url(issued.token);
  };

  const links: EmailLinks = {};
  if (kind === 'reminder') {
    const confirmUrl = await appointmentLink('appointment_confirm');
    if (confirmUrl !== undefined) links.confirmUrl = confirmUrl;
  }
  if (kind === 'reminder' || kind === 'confirmation') {
    const cancelUrl = await appointmentLink('appointment_cancel');
    if (cancelUrl !== undefined) links.cancelUrl = cancelUrl;
  }
  const optOutUrl = await optOutLink(deps, tx, subject);
  if (optOutUrl !== undefined) links.optOutUrl = optOutUrl;
  return links;
}
