/** What a template produces: the pieces of a message, without recipient or sender. */
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/** Only web links go into an email: anything else could run script or open an app. */
function assertWebLink(link: string): void {
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(link)) throw new Error('The email link must be http(s)');
}

function minutesText(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hora' : `${String(hours)} horas`;
  }
  return minutes === 1 ? '1 minuto' : `${String(minutes)} minutos`;
}

function daysText(days: number): string {
  return days === 1 ? '1 día' : `${String(days)} días`;
}

function page(
  heading: string,
  paragraphs: readonly string[],
  button: string,
  link: string,
  footer: string,
) {
  const body = paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join('\n');
  return `<!doctype html>
<html lang="es-AR">
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1f2937;">
<h1 style="font-size: 20px;">${heading}</h1>
${body}
<p><a href="${link}" style="display: inline-block; padding: 10px 18px; background: #0f766e; color: #ffffff; border-radius: 6px; text-decoration: none;">${button}</a></p>
<p style="font-size: 13px; color: #6b7280;">Si el botón no funciona, copiá este enlace en tu navegador:<br>${link}</p>
<p style="font-size: 13px; color: #6b7280;">${footer}</p>
</body>
</html>`;
}

export interface PasswordResetEmailInput {
  organizationName: string;
  /** The single-use link that carries the token. */
  link: string;
  expiresInMinutes: number;
}

/** "Restablecé tu contraseña": sent only when someone asks for a reset, or an admin triggers one. */
export function renderPasswordResetEmail(input: PasswordResetEmailInput): RenderedEmail {
  assertWebLink(input.link);
  const organization = input.organizationName;
  const lifetime = minutesText(input.expiresInMinutes);
  const subject = `Restablecé tu contraseña de ${organization}`;

  const text = [
    `Recibimos un pedido para restablecer tu contraseña de ${organization}.`,
    '',
    'Para elegir una nueva, abrí este enlace:',
    input.link,
    '',
    `El enlace sirve una sola vez y vence en ${lifetime}.`,
    '',
    'Si no pediste este cambio, ignorá este mensaje: tu contraseña no se modifica.',
  ].join('\n');

  const html = page(
    'Restablecé tu contraseña',
    [
      `Recibimos un pedido para restablecer tu contraseña de <strong>${escapeHtml(organization)}</strong>.`,
      `El enlace sirve una sola vez y vence en ${lifetime}.`,
    ],
    'Elegir una contraseña nueva',
    escapeHtml(input.link),
    'Si no pediste este cambio, ignorá este mensaje: tu contraseña no se modifica.',
  );
  return { subject, text, html };
}

export interface InvitationEmailInput {
  organizationName: string;
  inviterName?: string;
  link: string;
  expiresInDays: number;
}

/** "Te invitaron": the invitee sets their own password through the link; none is ever preset. */
export function renderInvitationEmail(input: InvitationEmailInput): RenderedEmail {
  assertWebLink(input.link);
  const organization = input.organizationName;
  const lifetime = daysText(input.expiresInDays);
  const subject = `Te invitaron a unirte a ${organization}`;
  const by = input.inviterName === undefined ? '' : ` ${input.inviterName} te invitó.`;

  const text = [
    `Te invitaron a unirte a ${organization}.${by}`.trim(),
    '',
    'Para aceptar la invitación y elegir tu contraseña, abrí este enlace:',
    input.link,
    '',
    `El enlace sirve una sola vez y vence en ${lifetime}.`,
    '',
    'Si no esperabas esta invitación, ignorá este mensaje.',
  ].join('\n');

  const htmlBy =
    input.inviterName === undefined ? '' : ` ${escapeHtml(input.inviterName)} te invitó.`;
  const html = page(
    'Te invitaron a unirte',
    [
      `Te invitaron a unirte a <strong>${escapeHtml(organization)}</strong>.${htmlBy}`,
      `Vas a poder elegir tu propia contraseña. El enlace sirve una sola vez y vence en ${lifetime}.`,
    ],
    'Aceptar la invitación',
    escapeHtml(input.link),
    'Si no esperabas esta invitación, ignorá este mensaje.',
  );
  return { subject, text, html };
}
