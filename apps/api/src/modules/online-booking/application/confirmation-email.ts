import type { RenderedEmail } from '../../../platform/mail/templates.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export interface BookingConfirmationEmailInput {
  organizationName: string;
  professionalName: string;
  locationName: string;
  startsAt: Date;
  timeZone: string;
  /** The booking waits for the organization to approve it. */
  pendingApproval: boolean;
  /** The link to change or cancel; null when the time has already passed. */
  manageLink: string | null;
  /** The link that accepts reminders by WhatsApp, when the visitor asked for them; else null. */
  whatsappOptInLink?: string | null;
}

/** "lunes 12 de mayo de 2031, 10:00" in the zone of the location. */
export function whenText(startsAt: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat('es-AR', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(startsAt);
  const time = new Intl.DateTimeFormat('es-AR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(startsAt);
  return `${date}, ${time}`;
}

/**
 * The email that tells a visitor their booking (online-booking, "Booking completion"). Date, place
 * and professional, nothing about the type of visit or the reason, and the link to change or cancel.
 * It is the same for a new patient and for one the organization already had.
 */
export function renderBookingConfirmationEmail(
  input: BookingConfirmationEmailInput,
): RenderedEmail {
  const when = whenText(input.startsAt, input.timeZone);
  const subject = input.pendingApproval
    ? `Recibimos su pedido de turno en ${input.organizationName}`
    : `Su turno en ${input.organizationName} está confirmado`;
  const headline = input.pendingApproval
    ? 'Recibimos su pedido. El consultorio lo va a confirmar y le avisaremos por este medio.'
    : 'Su turno está confirmado.';

  const whatsappLink = input.whatsappOptInLink ?? null;
  const text = [
    headline,
    '',
    `Cuándo: ${when} (hora de ${input.timeZone})`,
    `Dónde: ${input.locationName}`,
    `Con: ${input.professionalName}`,
    ...(input.manageLink === null
      ? []
      : ['', 'Para cambiar o cancelar el turno, use este enlace:', input.manageLink]),
    ...(whatsappLink === null
      ? []
      : [
          '',
          'Pidió recibir los recordatorios por WhatsApp. Para activarlos, abra este enlace y acepte:',
          whatsappLink,
        ]),
    '',
    'Si usted no pidió este turno, comuníquese con el consultorio.',
  ].join('\n');

  const manage =
    input.manageLink === null
      ? ''
      : `<p><a href="${escapeHtml(input.manageLink)}" style="display: inline-block; padding: 10px 18px; background: #0f766e; color: #ffffff; border-radius: 6px; text-decoration: none;">Cambiar o cancelar el turno</a></p>`;
  const html = `<!doctype html>
<html lang="es-AR">
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1f2937;">
<h1 style="font-size: 20px;">${escapeHtml(headline)}</h1>
<p><strong>Cuándo:</strong> ${escapeHtml(when)} (hora de ${escapeHtml(input.timeZone)})<br>
<strong>Dónde:</strong> ${escapeHtml(input.locationName)}<br>
<strong>Con:</strong> ${escapeHtml(input.professionalName)}</p>
${manage}
${
  whatsappLink === null
    ? ''
    : `<p>Pidió recibir los recordatorios por WhatsApp. <a href="${escapeHtml(whatsappLink)}">Active los recordatorios por WhatsApp</a>.</p>`
}
<p style="font-size: 13px; color: #6b7280;">Si usted no pidió este turno, comuníquese con el consultorio.</p>
</body>
</html>`;

  return { subject, text, html };
}
