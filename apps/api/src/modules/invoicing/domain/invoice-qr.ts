import type { InvoiceType } from '@consultorio/contracts';

/**
 * The QR code printed on an electronic voucher (ARCA/AFIP, "Código QR en comprobantes"): the
 * address of the verification page with the data of the voucher as base64url JSON. Pure: it only
 * arranges what the invoice already says. The numbers are JSON numbers, as the specification shows
 * them (the CUIT and the CAE fit a double exactly).
 */
export const AFIP_QR_BASE = 'https://www.afip.gob.ar/fe/qr/?p=';

/** The voucher codes of the authority. */
const VOUCHER_CODES: Record<InvoiceType, number> = {
  FA: 1,
  NCA: 3,
  FB: 6,
  NCB: 8,
  FC: 11,
  NCC: 13,
};

/** Document types of the recipient: CUIT 80, DNI 96, and 99 when there is no identification. */
const DOCUMENT_CODES = { cuit: 80, dni: 96 } as const;
const NO_DOCUMENT = 99;

export interface QrInvoice {
  /** `YYYY-MM-DD`. */
  issueDate: string;
  /** The 11 digits. */
  issuerCuit: string;
  pointOfSale: number;
  type: InvoiceType;
  number: number;
  totalCents: number;
  recipientDocument: { type: 'cuit' | 'dni'; number: string } | null;
  /** The 14 digits of the CAE. */
  cae: string;
}

export interface AfipQrPayload {
  ver: 1;
  fecha: string;
  cuit: number;
  ptoVta: number;
  tipoCmp: number;
  nroCmp: number;
  importe: number;
  moneda: 'PES';
  ctz: 1;
  tipoDocRec: number;
  nroDocRec: number;
  tipoCodAut: 'E';
  codAut: number;
}

/** Whole cents as a number of pesos: dividing by 100 gives the nearest double of the amount. */
function pesos(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

export function afipQrPayload(invoice: QrInvoice): AfipQrPayload {
  const document = invoice.recipientDocument;
  return {
    ver: 1,
    fecha: invoice.issueDate,
    cuit: Number(invoice.issuerCuit),
    ptoVta: invoice.pointOfSale,
    tipoCmp: VOUCHER_CODES[invoice.type],
    nroCmp: invoice.number,
    importe: pesos(invoice.totalCents),
    moneda: 'PES',
    ctz: 1,
    tipoDocRec: document ? DOCUMENT_CODES[document.type] : NO_DOCUMENT,
    nroDocRec: document ? Number(document.number) : 0,
    tipoCodAut: 'E',
    codAut: Number(invoice.cae),
  };
}

/** What the QR encodes: the address of the page of the authority with the payload in it. */
export function afipQrUrl(invoice: QrInvoice): string {
  return `${AFIP_QR_BASE}${Buffer.from(JSON.stringify(afipQrPayload(invoice))).toString('base64url')}`;
}

/** Reads a QR address back into its payload (for tests and for anything that verifies a voucher). */
export function decodeAfipQrUrl(url: string): AfipQrPayload {
  if (!url.startsWith(AFIP_QR_BASE)) throw new Error('not the QR address of a voucher');
  const encoded = url.slice(AFIP_QR_BASE.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('not the QR address of a voucher');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AfipQrPayload;
}
