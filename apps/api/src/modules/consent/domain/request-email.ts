import type { RenderedEmail } from '../../../platform/mail/templates.js';

/**
 * The email that tells a patient a consent is waiting for their signature (informed-consent,
 * "Requesting a consent": any notification MUST be an email and contain no clinical content,
 * including no template title). It says who asks and where to sign; it never says what for: no
 * template title, no specialty, no procedure. The channel policy of notifications keeps it off
 * WhatsApp (kind `consent_request`, email only).
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

export interface ConsentRequestEmailInput {
  organizationName: string;
  givenNames: string;
  /** The sign-in page of the patient portal of the organization. */
  portalUrl: string;
}

export function renderConsentRequestEmail(input: ConsentRequestEmailInput): RenderedEmail {
  const lines = [
    `Hola ${input.givenNames},`,
    `${input.organizationName} le pidió que firme un consentimiento.`,
    `Para leerlo y firmarlo, ingrese al portal del paciente con su correo electrónico: ${input.portalUrl}`,
    'Si no esperaba este mensaje, puede ignorarlo.',
  ];
  const text = lines.join('\n\n');
  const html = `<!doctype html>
<html lang="es-AR">
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1f2937;">
${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n')}
</body>
</html>`;
  return { subject: `${input.organizationName}: tiene un consentimiento para firmar`, text, html };
}
