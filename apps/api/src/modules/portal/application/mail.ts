import type { RenderedEmail } from '../../../platform/mail/templates.js';

/**
 * The emails of the portal (spec "Privacy of portal messages"). They are email only, they name the
 * organization and nothing else: no specialty, no reason for a visit, no title of a consent, no
 * medication, no name of the person. They link to the authenticated portal or carry a code; none
 * of them is itself a way in.
 */

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Only web links go into an email: anything else could run script or open an app. */
function assertWebLink(link: string): void {
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(link)) throw new Error('The email link must be http(s)');
}

function minutesText(minutes: number): string {
  return minutes === 1 ? '1 minuto' : `${String(minutes)} minutos`;
}

function daysText(days: number): string {
  return days === 1 ? '1 día' : `${String(days)} días`;
}

function layout(
  heading: string,
  paragraphs: readonly string[],
  footer: string,
  button?: { label: string; link: string },
) {
  const body = paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join('\n');
  const action =
    button === undefined
      ? ''
      : `<p><a href="${button.link}" style="display: inline-block; padding: 10px 18px; background: #0f766e; color: #ffffff; border-radius: 6px; text-decoration: none;">${escapeHtml(button.label)}</a></p>
<p style="font-size: 13px; color: #6b7280;">Si el botón no funciona, copie este enlace en su navegador:<br>${button.link}</p>`;
  return `<!doctype html>
<html lang="es-AR">
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1f2937;">
<h1 style="font-size: 20px;">${escapeHtml(heading)}</h1>
${body}
${action}
<p style="font-size: 13px; color: #6b7280;">${escapeHtml(footer)}</p>
</body>
</html>`;
}

export interface PortalInvitationEmailInput {
  organizationName: string;
  /** The single-use activation link. */
  link: string;
  expiresInDays: number;
}

/** The invitation to the portal: a link that activates the access, single use, expiring. */
export function renderPortalInvitationEmail(input: PortalInvitationEmailInput): RenderedEmail {
  assertWebLink(input.link);
  const organization = input.organizationName;
  const lifetime = daysText(input.expiresInDays);
  const subject = `Active su acceso al portal de pacientes de ${organization}`;
  const text = [
    `${organization} le invita a usar su portal de pacientes.`,
    '',
    'Para activar su acceso, abra este enlace:',
    '',
    input.link,
    '',
    `El enlace vence en ${lifetime} y sirve una sola vez.`,
    '',
    'Si usted no esperaba este mensaje, ignórelo: no se activa nada a su nombre.',
  ].join('\n');
  const html = layout(
    'Active su acceso al portal',
    [
      `${escapeHtml(organization)} le invita a usar su portal de pacientes.`,
      `El enlace vence en ${lifetime} y sirve una sola vez.`,
    ],
    'Si usted no esperaba este mensaje, ignórelo: no se activa nada a su nombre.',
    { label: 'Activar mi acceso', link: input.link },
  );
  return { subject, text, html };
}

export interface PortalCodeEmailInput {
  organizationName: string;
  /** Six digits. */
  code: string;
  expiresInMinutes: number;
  /** True for the code of a registration (it activates the access); false for a sign-in. */
  registration: boolean;
}

/**
 * The code to sign in or to activate the access. It carries the code and its life and no link,
 * so there is nothing in it to forward that would let somebody else in.
 */
export function renderPortalCodeEmail(input: PortalCodeEmailInput): RenderedEmail {
  const organization = input.organizationName;
  const lifetime = minutesText(input.expiresInMinutes);
  const subject = input.registration
    ? `Active su acceso al portal de ${organization}: su código`
    : `Ingrese al portal de ${organization}: su código`;
  const intro = input.registration
    ? 'Para activar su acceso al portal de pacientes, escriba este código en la página:'
    : 'Para ingresar al portal de pacientes, escriba este código en la página:';
  const ignore = 'Si usted no lo pidió, ignore este mensaje: nadie puede entrar sin el código.';
  const text = [
    `Pidió ingresar al portal de ${organization}.`,
    '',
    intro,
    '',
    input.code,
    '',
    `El código vence en ${lifetime} y sirve una sola vez.`,
    '',
    ignore,
  ].join('\n');
  const html = `<!doctype html>
<html lang="es-AR">
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1f2937;">
<h1 style="font-size: 20px;">${input.registration ? 'Active su acceso' : 'Ingrese al portal'}</h1>
<p>Pidió ingresar al portal de ${escapeHtml(organization)}.</p>
<p>${escapeHtml(intro)}</p>
<p style="font-size: 32px; letter-spacing: 6px; font-weight: 700;">${escapeHtml(input.code)}</p>
<p>El código vence en ${lifetime} y sirve una sola vez.</p>
<p style="font-size: 13px; color: #6b7280;">${escapeHtml(ignore)}</p>
</body>
</html>`;
  return { subject, text, html };
}

export type PortalNoticeKind = 'document_available' | 'consent_request';

export interface PortalNoticeEmailInput {
  organizationName: string;
  kind: PortalNoticeKind;
  /** The portal. Whoever follows it still has to sign in with a code. */
  link: string;
}

/**
 * "You have something waiting": a document shared with the patient, or a consent to sign. It says
 * that a document is waiting in the portal and nothing about it (no kind of document, no title).
 */
export function renderPortalNoticeEmail(input: PortalNoticeEmailInput): RenderedEmail {
  assertWebLink(input.link);
  const organization = input.organizationName;
  const subject = `Tiene un documento esperando en el portal de ${organization}`;
  const line =
    input.kind === 'consent_request'
      ? `${organization} le dejó un documento para revisar en su portal de pacientes.`
      : `${organization} puso un documento a su disposición en su portal de pacientes.`;
  const text = [
    line,
    '',
    'Para verlo, ingrese al portal con su correo:',
    '',
    input.link,
    '',
    'Este mensaje no incluye el contenido del documento.',
  ].join('\n');
  const html = layout(
    'Tiene un documento esperando',
    [escapeHtml(line), 'Para verlo, ingrese al portal con su correo.'],
    'Este mensaje no incluye el contenido del documento.',
    { label: 'Ir al portal', link: input.link },
  );
  return { subject, text, html };
}

export interface PortalRequestNoticeInput {
  organizationName: string;
  /** What the patient asked for. */
  kind: 'copy' | 'rectification';
  patientName: string;
  /** The file of the patient in the staff application, where the request is. */
  link: string;
}

/**
 * The notice that goes to the organization (not to the patient) when a patient makes a request from
 * the portal. It says who asked and what kind of request it is, and nothing of what they asked: no
 * note, no value, nothing clinical.
 */
export function renderPortalRequestNoticeEmail(input: PortalRequestNoticeInput): RenderedEmail {
  assertWebLink(input.link);
  const what =
    input.kind === 'copy'
      ? 'una copia de su historia clínica'
      : 'la corrección de un dato de su ficha';
  const subject = `Nueva solicitud de un paciente desde el portal de ${input.organizationName}`;
  const line = `${input.patientName} pidió ${what} desde el portal de pacientes.`;
  const text = [
    line,
    '',
    'Para verla y responderla, abra la ficha del paciente:',
    '',
    input.link,
    '',
    'Este mensaje no incluye el detalle de la solicitud.',
  ].join('\n');
  const html = layout(
    'Nueva solicitud de un paciente',
    [escapeHtml(line), 'Para verla y responderla, abra la ficha del paciente.'],
    'Este mensaje no incluye el detalle de la solicitud.',
    { label: 'Abrir la ficha', link: input.link },
  );
  return { subject, text, html };
}
