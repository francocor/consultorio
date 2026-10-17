import { eq } from 'drizzle-orm';

import { membership } from '../../../db/schema/identity.js';
import { professional } from '../../../db/schema/staff.js';
import { location, tenant } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import type { RenderedEmail } from '../../../platform/mail/templates.js';
import { readPatientContact } from '../../patients/index.js';
import { readOrganizationName } from '../../tenancy/index.js';

import type { DeliverWaitlistOffer } from './ports.js';
import { reachOf } from './reachability.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** "lunes, 12 de mayo de 2031, 10:00" in the zone of the place. */
function whenText(date: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('es-AR', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
  return `${day}, ${clockText(date, timeZone)}`;
}

function clockText(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

export interface OfferEmailInput {
  organizationName: string;
  /** Only the first given name: an email is not the place for a full name. */
  firstName: string;
  /** Null when the organization does not name the professional in messages. */
  professionalName: string | null;
  locationName: string;
  startsAt: Date;
  timeZone: string;
  expiresAt: Date;
  link: string;
}

/**
 * The email that offers a freed slot (waitlist, "Offers with expiry"): date, time, place and, unless
 * the organization hides it, the professional; when the offer ends; one link to accept or decline.
 * No type of visit and no reason: nothing clinical.
 */
export function renderOfferEmail(input: OfferEmailInput): RenderedEmail {
  const name = input.firstName.trim().split(/\s+/)[0] ?? '';
  const when = whenText(input.startsAt, input.timeZone);
  const until = clockText(input.expiresAt, input.timeZone);
  const subject = `Hay un turno disponible en ${input.organizationName}`;
  const intro = 'Se liberó un turno que usted estaba esperando.';
  const ending = `La oferta vale hasta las ${until} (hora de ${input.timeZone}). Después se la ofrecemos a otra persona.`;

  const text = [
    `Hola ${name},`,
    '',
    intro,
    '',
    `Cuándo: ${when}`,
    `Dónde: ${input.locationName}`,
    ...(input.professionalName === null ? [] : [`Con: ${input.professionalName}`]),
    '',
    ending,
    'Para aceptarlo o rechazarlo, abra este enlace:',
    input.link,
    '',
    'Seguirá en la lista de espera si lo rechaza o no responde.',
  ].join('\n');

  const html = `<!doctype html>
<html lang="es-AR">
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1f2937;">
<p>Hola ${escapeHtml(name)},</p>
<h1 style="font-size: 20px;">${escapeHtml(intro)}</h1>
<p><strong>Cuándo:</strong> ${escapeHtml(when)}<br>
<strong>Dónde:</strong> ${escapeHtml(input.locationName)}${
    input.professionalName === null
      ? ''
      : `<br>\n<strong>Con:</strong> ${escapeHtml(input.professionalName)}`
  }</p>
<p>${escapeHtml(ending)}</p>
<p><a href="${escapeHtml(input.link)}" style="display: inline-block; padding: 10px 18px; background: #0f766e; color: #ffffff; border-radius: 6px; text-decoration: none;">Ver la oferta</a></p>
<p style="font-size: 13px; color: #6b7280;">Seguirá en la lista de espera si lo rechaza o no responde.</p>
</body>
</html>`;

  return { subject, text, html };
}

/** The `hideProfessional` wording of the organization (messaging settings). */
async function hidesProfessional(tx: Tx): Promise<boolean> {
  const [row] = await tx.select({ settings: tenant.settings }).from(tenant);
  const section = row?.settings['notifications'];
  return (
    typeof section === 'object' &&
    section !== null &&
    (section as Record<string, unknown>)['hideProfessional'] === true
  );
}

/**
 * The delivery of offers the waitlist has until the notifications module's own is connected
 * (`main/wiring/waitlist.ts` is the one place that chooses): a plain email to the patient, only when
 * they have an address and have not opted out of email. It cannot use WhatsApp. It answers `none`
 * when the patient cannot be reached by email.
 */
export function createEmailOfferDelivery(deps: { email: EmailSender }): DeliverWaitlistOffer {
  return async (tx, input) => {
    const reach = await reachOf(tx, input.patientId);
    const contact = await readPatientContact(tx, input.patientId);
    if (!reach.email.usable || !contact?.email) return { channel: 'none', messageId: null };

    const [organization] = await tx.select({ id: tenant.id, isDemo: tenant.isDemo }).from(tenant);
    const [place] = await tx
      .select({ name: location.name, timeZone: location.timeZone })
      .from(location)
      .where(eq(location.id, input.locationId));
    const [who] = await tx
      .select({ name: membership.displayName })
      .from(professional)
      .innerJoin(membership, eq(membership.id, professional.membershipId))
      .where(eq(professional.id, input.professionalId));
    if (!organization || !place) return { channel: 'none', messageId: null };

    const rendered = renderOfferEmail({
      organizationName: await readOrganizationName(tx),
      firstName: contact.givenNames,
      professionalName: (await hidesProfessional(tx)) ? null : (who?.name?.trim() ?? 'Profesional'),
      locationName: place.name,
      startsAt: input.startsAt,
      timeZone: place.timeZone,
      expiresAt: input.expiresAt,
      link: input.offerTokenUrl,
    });
    await deps.email.send({
      to: contact.email,
      tenant: { id: organization.id, isDemo: organization.isDemo },
      ...rendered,
    });
    return { channel: 'email', messageId: null };
  };
}
