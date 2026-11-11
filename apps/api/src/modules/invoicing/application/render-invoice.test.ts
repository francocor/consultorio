import { describe, expect, it } from 'vitest';

import { allText, readPdf } from '../../../../test/support/pdf.js';
import { decodeAfipQrUrl } from '../domain/invoice-qr.js';

import { renderInvoice, type InvoiceDocumentData } from './render-invoice.js';

/**
 * The invoice document (S4.12, task 4.51; spec "Invoice document and delivery", "Language"): the
 * fiscal data AFIP requires, the CAE and its expiry, the QR with the data of the voucher, generic
 * service wording, es-AR with AFIP terminology, and the mark of a test document.
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const base: InvoiceDocumentData = {
  type: 'FC',
  pointOfSale: 5,
  number: 77,
  issueDate: '2031-05-20',
  cae: '70123456789012',
  caeExpiresOn: '2031-05-30',
  issuedAt: new Date('2031-05-20T15:00:00Z'),
  issuer: {
    businessName: 'Consultorio Aillu',
    cuit: '20123456786',
    taxCondition: 'monotributo',
    address: 'Av. Siempre Viva 123, CABA',
    activityStartedOn: '2020-03-01',
  },
  recipient: {
    name: 'Juana Pérez',
    taxCondition: 'consumidor_final',
    document: { type: 'dni', number: '30111222' },
  },
  lines: [{ description: 'Consulta profesional', amountCents: 2_000_050 }],
  totalCents: 2_000_050,
  netCents: 2_000_050,
  vatCents: 0,
  exemptCents: 0,
  testDocument: false,
  associated: null,
};

/** A QR maker that records what it was asked to encode, and answers a real (tiny) PNG. */
function qrSpy() {
  const encoded: string[] = [];
  return {
    encoded,
    makeQr: (text: string) => {
      encoded.push(text);
      return Promise.resolve(PNG);
    },
  };
}

async function textOf(data: InvoiceDocumentData) {
  const qr = qrSpy();
  const bytes = await renderInvoice(data, { makeQr: qr.makeQr });
  return { bytes, text: allText(readPdf(bytes)), qr };
}

describe('the invoice document', () => {
  it('is a PDF with the fiscal data of the voucher in Spanish with AFIP terminology', async () => {
    const { bytes, text } = await textOf(base);

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(text).toContain('Consultorio Aillu');
    expect(text).toContain('CUIT 20-12345678-6');
    expect(text).toContain('Factura C');
    expect(text).toContain('Cód. 011');
    expect(text).toContain('Punto de venta 0005');
    expect(text).toContain('Comp. Nro 00000077');
    expect(text).toContain('Fecha de emisión 20/05/2031');
    expect(text).toContain('Responsable Monotributo');
    expect(text).toContain('Inicio de actividades 01/03/2020');
    expect(text).toContain('Juana Pérez');
    expect(text).toContain('DNI 30111222');
    expect(text).toContain('Consumidor Final');
    expect(text).toContain('Consulta profesional');
    expect(text).toContain('Importe total $ 20.000,50');
  });

  it('prints the CAE and its expiry, and the QR of the voucher', async () => {
    const { text, qr } = await textOf(base);

    expect(text).toContain('CAE N° 70123456789012');
    expect(text).toContain('Fecha de Vto. de CAE 30/05/2031');
    expect(qr.encoded).toHaveLength(1);
    // The QR decodes to the data of the voucher: nothing else, nothing missing.
    expect(decodeAfipQrUrl(qr.encoded[0] ?? '')).toEqual({
      ver: 1,
      fecha: '2031-05-20',
      cuit: 20123456786,
      ptoVta: 5,
      tipoCmp: 11,
      nroCmp: 77,
      importe: 20000.5,
      moneda: 'PES',
      ctz: 1,
      tipoDocRec: 96,
      nroDocRec: 30111222,
      tipoCodAut: 'E',
      codAut: 70123456789012,
    });
  });

  it('has a QR for a recipient with a CUIT, and one with no identification at all', async () => {
    const company = await textOf({
      ...base,
      type: 'FA',
      recipient: {
        name: 'Clínica del Sur S.A.',
        taxCondition: 'responsable_inscripto',
        document: { type: 'cuit', number: '30712345671' },
      },
      netCents: 0,
      exemptCents: 2_000_050,
    });
    const anonymous = await textOf({
      ...base,
      recipient: { name: null, taxCondition: 'consumidor_final', document: null },
    });

    expect(decodeAfipQrUrl(company.qr.encoded[0] ?? '')).toMatchObject({
      tipoCmp: 1,
      tipoDocRec: 80,
      nroDocRec: 30712345671,
    });
    expect(company.text).toContain('Factura A');
    expect(company.text).toContain('CUIT 30-71234567-1');
    expect(company.text).toContain('IVA Responsable Inscripto');
    expect(company.text).toContain('Importe exento $ 20.000,50');
    expect(decodeAfipQrUrl(anonymous.qr.encoded[0] ?? '')).toMatchObject({
      tipoDocRec: 99,
      nroDocRec: 0,
    });
    expect(anonymous.text).toContain('Consumidor Final');
  });

  it('says it is a test document when a simulator or a test environment is behind it', async () => {
    const test = await textOf({ ...base, testDocument: true });
    const real = await textOf(base);

    expect(test.text).toContain('Documento de prueba sin validez fiscal');
    expect(real.text).not.toMatch(/prueba/i);
  });

  it('is a Nota de Crédito for a credit note, naming the voucher it cancels', async () => {
    const { text, qr } = await textOf({
      ...base,
      type: 'NCC',
      number: 78,
      associated: { type: 'FC', pointOfSale: 5, number: 77 },
    });

    expect(text).toContain('Nota de Crédito C');
    expect(text).toContain('Cód. 013');
    expect(text).toContain('Comprobante asociado Factura C 0005-00000077');
    expect(decodeAfipQrUrl(qr.encoded[0] ?? '')).toMatchObject({ tipoCmp: 13, nroCmp: 78 });
  });

  it('shows only what the lines say, never what a person typed anywhere else', async () => {
    const { text } = await textOf({
      ...base,
      lines: [
        { description: 'Consulta profesional', amountCents: 1_500_000 },
        { description: 'Otros conceptos', amountCents: 500_050 },
      ],
    });

    expect(text).toContain('Consulta profesional');
    expect(text).toContain('Otros conceptos');
    expect(text).not.toMatch(/diagn|tratamiento|receta|historia cl/i);
  });

  it('draws a real QR image when nothing replaces the maker', async () => {
    const plain = await renderInvoice(base, { makeQr: () => Promise.resolve(PNG) });

    const withQr = await renderInvoice(base);

    expect(withQr.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // The real QR is a bigger image than the one-pixel stand-in.
    expect(withQr.length).toBeGreaterThan(plain.length);
    expect(readPdf(withQr).pages).toBe(1);
  });

  it('renders the same bytes for the same voucher, so a copy is a copy', async () => {
    const first = await textOf(base);
    const second = await textOf(base);

    expect(first.bytes.equals(second.bytes)).toBe(true);
  });

  it('draws the characters of Spanish and replaces what the font cannot draw', async () => {
    const { text } = await textOf({
      ...base,
      recipient: {
        name: 'Ñandú Ángel Ibáñez ¿?',
        taxCondition: 'consumidor_final',
        document: null,
      },
    });

    expect(text).toContain('Ñandú Ángel Ibáñez ¿?');
  });
});
