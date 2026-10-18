import { formatArs, money, type InvoiceType } from '@consultorio/contracts';

import type { RenderedEmail } from '../../../platform/mail/templates.js';

/**
 * The email that delivers an invoice (e-invoicing-afip, "Invoice document and delivery"): who
 * issued which voucher and for how much. It carries no clinical content and no line of the invoice
 * (a payment is not a reason to say what the visit was), no link (the patient has no session yet:
 * the portal of Stage 5 serves the document) and no attachment. WhatsApp is never used for it.
 */

const NAMES: Record<InvoiceType, string> = {
  FA: 'Factura A',
  FB: 'Factura B',
  FC: 'Factura C',
  NCA: 'Nota de Crédito A',
  NCB: 'Nota de Crédito B',
  NCC: 'Nota de Crédito C',
};

const TEST_MARK = 'Documento de prueba sin validez fiscal';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

export interface InvoiceEmailInput {
  organizationName: string;
  givenNames: string;
  type: InvoiceType;
  pointOfSale: number;
  number: number;
  totalCents: number;
  testDocument: boolean;
}

export function renderInvoiceEmail(input: InvoiceEmailInput): RenderedEmail {
  const voucher = `${NAMES[input.type]} ${String(input.pointOfSale).padStart(4, '0')}-${String(input.number).padStart(8, '0')}`;
  const amount = formatArs(money(input.totalCents));
  const lines = [
    `Hola ${input.givenNames},`,
    // Both a Factura and a Nota de Crédito are feminine.
    `${input.organizationName} emitió la ${voucher} por ${amount}.`,
    'Si necesita una copia, pídala en el consultorio o descárguela del portal del paciente.',
    ...(input.testDocument ? [TEST_MARK] : []),
  ];

  const text = lines.join('\n\n');
  const html = `<!doctype html>
<html lang="es-AR">
<body style="font-family: system-ui, sans-serif; line-height: 1.5; color: #1f2937;">
${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n')}
</body>
</html>`;
  return {
    subject: `${input.organizationName}: su ${voucher}`,
    text,
    html,
  };
}
