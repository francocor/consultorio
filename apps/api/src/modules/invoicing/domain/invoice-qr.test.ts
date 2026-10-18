import { describe, expect, it } from 'vitest';

import { AFIP_QR_BASE, afipQrPayload, afipQrUrl, decodeAfipQrUrl } from './invoice-qr.js';

const invoice = {
  issueDate: '2031-05-20',
  issuerCuit: '20123456786',
  pointOfSale: 5,
  type: 'FC' as const,
  number: 77,
  totalCents: 2_000_050,
  recipientDocument: { type: 'dni' as const, number: '30111222' },
  cae: '70123456789012',
};

describe('the QR of an AFIP voucher (e-invoicing-afip, "Invoice document and delivery")', () => {
  it('carries the data of the voucher in the fields AFIP names, amounts in pesos', () => {
    expect(afipQrPayload(invoice)).toEqual({
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

  it('gives each voucher type its code, credit notes included', () => {
    const codes = (['FA', 'FB', 'FC', 'NCA', 'NCB', 'NCC'] as const).map(
      (type) => afipQrPayload({ ...invoice, type }).tipoCmp,
    );

    expect(codes).toEqual([1, 6, 11, 3, 8, 13]);
  });

  it('names the document of the recipient: CUIT is 80, DNI is 96, and none is 99 with a zero', () => {
    const cuit = afipQrPayload({
      ...invoice,
      recipientDocument: { type: 'cuit', number: '30712345671' },
    });
    const none = afipQrPayload({ ...invoice, recipientDocument: null });

    expect([cuit.tipoDocRec, cuit.nroDocRec]).toEqual([80, 30712345671]);
    expect([none.tipoDocRec, none.nroDocRec]).toEqual([99, 0]);
  });

  it('turns cents into pesos without a float error', () => {
    for (const [cents, pesos] of [
      [1, 0.01],
      [10, 0.1],
      [2_999, 29.99],
      [123_456_789, 1_234_567.89],
    ] as const) {
      expect(afipQrPayload({ ...invoice, totalCents: cents }).importe).toBe(pesos);
    }
  });

  it('is the address of AFIP with the payload as unpadded base64url JSON, and decodes back', () => {
    const url = afipQrUrl(invoice);

    expect(url.startsWith(AFIP_QR_BASE)).toBe(true);
    expect(AFIP_QR_BASE).toBe('https://www.afip.gob.ar/fe/qr/?p=');
    const encoded = url.slice(AFIP_QR_BASE.length);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeAfipQrUrl(url)).toEqual(afipQrPayload(invoice));
    // Any other voucher gives another address.
    expect(afipQrUrl({ ...invoice, number: 78 })).not.toBe(url);
  });

  it('refuses an address that is not the QR of a voucher', () => {
    expect(() => decodeAfipQrUrl('https://example.com/?p=abc')).toThrow();
    expect(() => decodeAfipQrUrl(`${AFIP_QR_BASE}!!!`)).toThrow();
  });
});
