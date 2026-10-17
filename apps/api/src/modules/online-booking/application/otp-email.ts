import type { RenderedEmail } from '../../../platform/mail/templates.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export interface BookingCodeEmailInput {
  organizationName: string;
  /** Six digits. */
  code: string;
  expiresInMinutes: number;
}

/**
 * The email with the code that confirms a booking made on the public page. It names the
 * organization and carries the code and nothing else: no appointment details, no name, no link
 * (nothing in it can be forwarded to get something).
 */
export function renderBookingCodeEmail(input: BookingCodeEmailInput): RenderedEmail {
  const organization = input.organizationName;
  const subject = `Su código para confirmar el turno en ${organization}`;
  const lifetime =
    input.expiresInMinutes === 1 ? '1 minuto' : `${String(input.expiresInMinutes)} minutos`;

  const text = [
    `Pidió un turno en ${organization}.`,
    '',
    'Para confirmarlo, escriba este código en la página:',
    '',
    input.code,
    '',
    `El código vence en ${lifetime} y sirve una sola vez.`,
    '',
    'Si usted no pidió un turno, ignore este mensaje: no se reserva nada a su nombre.',
  ].join('\n');

  const html = `<!doctype html>
<html lang="es-AR">
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1f2937;">
<h1 style="font-size: 20px;">Confirme su turno</h1>
<p>Pidió un turno en ${escapeHtml(organization)}. Para confirmarlo, escriba este código en la página:</p>
<p style="font-size: 32px; letter-spacing: 6px; font-weight: 700;">${escapeHtml(input.code)}</p>
<p>El código vence en ${lifetime} y sirve una sola vez.</p>
<p style="font-size: 13px; color: #6b7280;">Si usted no pidió un turno, ignore este mensaje: no se reserva nada a su nombre.</p>
</body>
</html>`;

  return { subject, text, html };
}
