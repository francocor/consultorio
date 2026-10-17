import type { RenderedEmail } from '../../../platform/mail/templates.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export interface JoinCodeEmailInput {
  organizationName: string;
  /** Six digits. */
  code: string;
  expiresInMinutes: number;
}

/**
 * The email with the code that confirms a request to join the waitlist made on the public page. It
 * names the organization and carries the code and nothing else: no name, no details of the wait,
 * no link (nothing in it can be forwarded to get something).
 */
export function renderJoinCodeEmail(input: JoinCodeEmailInput): RenderedEmail {
  const organization = input.organizationName;
  const subject = `Su código para anotarse en la lista de espera de ${organization}`;
  const lifetime =
    input.expiresInMinutes === 1 ? '1 minuto' : `${String(input.expiresInMinutes)} minutos`;

  const text = [
    `Pidió anotarse en la lista de espera de ${organization}.`,
    '',
    'Para confirmarlo, escriba este código en la página:',
    '',
    input.code,
    '',
    `El código vence en ${lifetime} y sirve una sola vez.`,
    '',
    'Si usted no lo pidió, ignore este mensaje: no se anota a nadie.',
  ].join('\n');

  const html = `<!doctype html>
<html lang="es-AR">
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1f2937;">
<h1 style="font-size: 20px;">Confirme su lugar en la lista de espera</h1>
<p>Pidió anotarse en la lista de espera de ${escapeHtml(organization)}. Para confirmarlo, escriba este código en la página:</p>
<p style="font-size: 32px; letter-spacing: 6px; font-weight: 700;">${escapeHtml(input.code)}</p>
<p>El código vence en ${lifetime} y sirve una sola vez.</p>
<p style="font-size: 13px; color: #6b7280;">Si usted no lo pidió, ignore este mensaje: no se anota a nadie.</p>
</body>
</html>`;

  return { subject, text, html };
}
