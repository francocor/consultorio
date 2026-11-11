import { describe, expect, it } from 'vitest';

import { renderInvoiceEmail } from './invoice-email.js';

/** Words that would make an email about a payment a clinical disclosure. None may appear. */
const CLINICAL_WORDS =
  /diagn[oó]stic|tratamiento|receta|medicaci[oó]n|estudio|an[aá]lisis|s[ií]ntoma|enfermedad|terapia|psicolog|psiquiat|cl[ií]nic|patolog|consulta|sesi[oó]n|turno|profesional|especialidad/i;

const base = {
  organizationName: 'Consultorio Aillu',
  givenNames: 'Juana',
  type: 'FC' as const,
  pointOfSale: 5,
  number: 77,
  totalCents: 2_000_050,
  testDocument: false,
};

describe('the email that delivers an invoice (spec "Invoice document and delivery")', () => {
  it('says who issued which voucher for how much, in Spanish, and nothing else', () => {
    const email = renderInvoiceEmail(base);

    expect(email.subject).toBe('Consultorio Aillu: su Factura C 0005-00000077');
    expect(email.text).toContain('Hola Juana,');
    expect(email.text).toContain('Consultorio Aillu emitió la Factura C 0005-00000077');
    expect(email.text).toContain('$ 20.000,50');
    expect(email.html).toContain('lang="es-AR"');
    expect(email.html).toContain('$ 20.000,50');
  });

  it('carries no clinical word, whatever the organization is called after', () => {
    for (const email of [
      renderInvoiceEmail(base),
      renderInvoiceEmail({ ...base, type: 'NCB', totalCents: 1, testDocument: true }),
    ]) {
      expect(`${email.subject}\n${email.text}\n${email.html}`).not.toMatch(CLINICAL_WORDS);
    }
  });

  it('names a credit note as what it is', () => {
    const email = renderInvoiceEmail({ ...base, type: 'NCC', number: 78 });

    expect(email.subject).toBe('Consultorio Aillu: su Nota de Crédito C 0005-00000078');
    expect(email.text).toContain('Nota de Crédito C 0005-00000078');
  });

  it('says it is a test document when it is one, and does not when it is not', () => {
    const test = renderInvoiceEmail({ ...base, testDocument: true });
    const real = renderInvoiceEmail(base);

    expect(test.text).toContain('Documento de prueba sin validez fiscal');
    expect(test.html).toContain('Documento de prueba sin validez fiscal');
    expect(real.text).not.toMatch(/prueba/i);
  });

  it('escapes what a person typed (the name of the organization and the recipient) in the HTML', () => {
    const email = renderInvoiceEmail({
      ...base,
      organizationName: 'Aillu <script>alert(1)</script> & Co',
      givenNames: '"Juana"',
    });

    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('&amp; Co');
    expect(email.html).toContain('&quot;Juana&quot;');
  });

  it('has no link and no attachment: the document is asked for or downloaded in the portal', () => {
    const email = renderInvoiceEmail(base);

    expect(email.text).not.toMatch(/https?:\/\//);
    expect(email.html).not.toMatch(/<a\s/i);
  });
});
