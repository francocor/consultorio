/**
 * The two emails of the signup, in es-AR and in the formal register of the product. Neither carries
 * health data (there is none yet) and neither says anything that a stranger who typed the address
 * could not already know: the first goes to the address that asked for it, the second tells the
 * holder of an account that somebody tried to open an organization with it.
 */
export interface RenderedSignupEmail {
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

function hoursText(hours: number): string {
  return hours === 1 ? '1 hora' : `${String(hours)} horas`;
}

function frame(
  heading: string,
  paragraphs: readonly string[],
  action: { label: string; link: string } | null,
  footer: string,
): string {
  const body = paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join('\n');
  const button =
    action === null
      ? ''
      : `<p><a href="${action.link}" style="display: inline-block; padding: 10px 18px; background: #0f766e; color: #ffffff; border-radius: 6px; text-decoration: none;">${action.label}</a></p>
<p style="font-size: 13px; color: #6b7280;">Si el botón no funciona, copie este enlace en su navegador:<br>${action.link}</p>`;
  return `<!doctype html>
<html lang="es-AR">
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1f2937;">
<h1 style="font-size: 20px;">${heading}</h1>
${body}
${button}
<p style="font-size: 13px; color: #6b7280;">${footer}</p>
</body>
</html>`;
}

export interface VerificationEmailInput {
  ownerName: string;
  organizationName: string;
  /** The single-use link that carries the token. */
  link: string;
  expiresInHours: number;
}

/** "Confirme su correo": the link that activates the organization. */
export function renderVerificationEmail(input: VerificationEmailInput): RenderedSignupEmail {
  assertWebLink(input.link);
  const lifetime = hoursText(input.expiresInHours);
  const subject = 'Confirme su correo para activar su organización';
  const footer = 'Si no pidió crear esta cuenta, ignore este mensaje: no se activa nada.';

  const text = [
    `Hola, ${input.ownerName}.`,
    '',
    `Recibimos el registro de la organización "${input.organizationName}". Para activarla y empezar el período de prueba, confirme su correo con este enlace:`,
    input.link,
    '',
    `El enlace sirve una sola vez y vence en ${lifetime}. Si venció, pida uno nuevo desde la misma página.`,
    '',
    footer,
  ].join('\n');

  const html = frame(
    'Confirme su correo',
    [
      `Hola, ${escapeHtml(input.ownerName)}.`,
      `Recibimos el registro de la organización <strong>${escapeHtml(input.organizationName)}</strong>. Para activarla y empezar el período de prueba, confirme su correo.`,
      `El enlace sirve una sola vez y vence en ${lifetime}. Si venció, pida uno nuevo desde la misma página.`,
    ],
    { label: 'Confirmar mi correo', link: escapeHtml(input.link) },
    footer,
  );
  return { subject, text, html };
}

/**
 * What the holder of an account is told when somebody asks to open an organization with their
 * address. It opens nothing and links nowhere: whoever it was, the holder only learns that it
 * happened and how to get back into their account if they need to.
 */
export function renderExistingAccountEmail(): RenderedSignupEmail {
  const subject = 'Alguien pidió crear una organización con su correo';
  const footer = 'Si no fue usted, no necesita hacer nada: su cuenta no cambió.';

  const text = [
    'Hola.',
    '',
    'Alguien pidió crear una organización nueva con este correo, que ya tiene una cuenta.',
    'No se creó ni se modificó nada. Si fue usted, ingrese con su cuenta desde la dirección de su organización; si no recuerda su contraseña, use la opción "Olvidé mi contraseña" de esa pantalla.',
    '',
    footer,
  ].join('\n');

  const html = frame(
    'Alguien pidió crear una organización con su correo',
    [
      'Este correo ya tiene una cuenta, por eso no se creó ni se modificó nada.',
      'Si fue usted, ingrese con su cuenta desde la dirección de su organización; si no recuerda su contraseña, use la opción &laquo;Olvidé mi contraseña&raquo; de esa pantalla.',
    ],
    null,
    footer,
  );
  return { subject, text, html };
}
