import {
  formatArs,
  money,
  type InvoiceType,
  type RecipientTaxCondition,
  type TaxCondition,
} from '@consultorio/contracts';
import QRCode from 'qrcode';

import { renderPdf, type PdfBlock } from '../../../platform/pdf/render.js';
import { afipQrUrl } from '../domain/invoice-qr.js';

/**
 * The invoice document (e-invoicing-afip, "Invoice document and delivery" and "Language"): the
 * fiscal data AFIP requires, the CAE and its expiry, the QR with the data of the voucher, the
 * generic wording of the lines, es-AR with the official terminology. Everything it prints comes
 * from the invoice record, which is immutable once issued: the same voucher renders the same bytes.
 * It goes through the shared PDF frame, which draws the mark of a test document.
 */

export interface InvoiceDocumentData {
  type: InvoiceType;
  pointOfSale: number;
  number: number;
  /** `YYYY-MM-DD`. */
  issueDate: string;
  /** The 14 digits of the CAE. */
  cae: string;
  caeExpiresOn: string | null;
  /** Goes into the file as its creation date: never "now", so the bytes are stable. */
  issuedAt: Date;
  issuer: {
    businessName: string;
    /** The 11 digits. */
    cuit: string;
    taxCondition: TaxCondition;
    address: string;
    activityStartedOn: string;
  };
  recipient: {
    name: string | null;
    taxCondition: RecipientTaxCondition;
    document: { type: 'cuit' | 'dni'; number: string } | null;
  };
  lines: readonly { description: string; amountCents: number }[];
  totalCents: number;
  netCents: number;
  vatCents: number;
  exemptCents: number;
  /** A test environment or a simulator is behind the voucher: it has no fiscal validity. */
  testDocument: boolean;
  /** For a credit note: the voucher it cancels. */
  associated: { type: InvoiceType; pointOfSale: number; number: number } | null;
}

export const TEST_DOCUMENT_MARK = 'Documento de prueba sin validez fiscal';

const TITLES: Record<InvoiceType, { name: string; code: string }> = {
  FA: { name: 'Factura A', code: '001' },
  FB: { name: 'Factura B', code: '006' },
  FC: { name: 'Factura C', code: '011' },
  NCA: { name: 'Nota de Crédito A', code: '003' },
  NCB: { name: 'Nota de Crédito B', code: '008' },
  NCC: { name: 'Nota de Crédito C', code: '013' },
};

const ISSUER_CONDITIONS: Record<TaxCondition, string> = {
  monotributo: 'Responsable Monotributo',
  responsable_inscripto: 'IVA Responsable Inscripto',
  exento: 'IVA Exento',
};

const RECIPIENT_CONDITIONS: Record<RecipientTaxCondition, string> = {
  consumidor_final: 'Consumidor Final',
  responsable_inscripto: 'IVA Responsable Inscripto',
  monotributo: 'Responsable Monotributo',
  exento: 'IVA Sujeto Exento',
};

/** `20123456786` as `20-12345678-6`. */
function cuitText(digits: string): string {
  return digits.length === 11
    ? `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`
    : digits;
}

/** `2031-05-20` as `20/05/2031`. */
function dayText(day: string): string {
  const [year = '', month = '', date = ''] = day.split('-');
  return `${date}/${month}/${year}`;
}

const padded = (value: number, width: number) => String(value).padStart(width, '0');

/** `0005-00000077`, as a voucher number is written. */
function voucherNumber(pointOfSale: number, number: number): string {
  return `${padded(pointOfSale, 4)}-${padded(number, 8)}`;
}

function documentText(document: { type: 'cuit' | 'dni'; number: string }): string {
  return document.type === 'cuit' ? `CUIT ${cuitText(document.number)}` : `DNI ${document.number}`;
}

export interface RenderInvoiceOptions {
  /** Makes the PNG of a QR code. Replaceable in tests; the default draws a real one. */
  makeQr?: (text: string) => Promise<Buffer>;
}

const defaultQr = (text: string): Promise<Buffer> =>
  QRCode.toBuffer(text, { type: 'png', margin: 1, width: 240, errorCorrectionLevel: 'M' });

/** Renders the PDF of an issued invoice or credit note. */
export async function renderInvoice(
  data: InvoiceDocumentData,
  options: RenderInvoiceOptions = {},
): Promise<Buffer> {
  const makeQr = options.makeQr ?? defaultQr;
  const title = TITLES[data.type];
  const qr = await makeQr(
    afipQrUrl({
      issueDate: data.issueDate,
      issuerCuit: data.issuer.cuit,
      pointOfSale: data.pointOfSale,
      type: data.type,
      number: data.number,
      totalCents: data.totalCents,
      recipientDocument: data.recipient.document,
      cae: data.cae,
    }),
  );

  const money$ = (cents: number) => formatArs(money(cents));
  const totals =
    data.type === 'FC' || data.type === 'NCC'
      ? [{ label: 'Importe total', value: money$(data.totalCents) }]
      : [
          { label: 'Importe neto gravado', value: money$(data.netCents) },
          { label: 'IVA', value: money$(data.vatCents) },
          { label: 'Importe exento', value: money$(data.exemptCents) },
          { label: 'Importe total', value: money$(data.totalCents) },
        ];

  const blocks: PdfBlock[] = [
    { kind: 'heading', text: title.name },
    { kind: 'paragraph', text: `Cód. ${title.code}`, muted: true },
    ...(data.testDocument ? [{ kind: 'paragraph', text: TEST_DOCUMENT_MARK } as const] : []),
    {
      kind: 'fields',
      rows: [
        { label: 'Punto de venta', value: padded(data.pointOfSale, 4) },
        { label: 'Comp. Nro', value: padded(data.number, 8) },
        { label: 'Fecha de emisión', value: dayText(data.issueDate) },
        ...(data.associated
          ? [
              {
                label: 'Comprobante asociado',
                value: `${TITLES[data.associated.type].name} ${voucherNumber(
                  data.associated.pointOfSale,
                  data.associated.number,
                )}`,
              },
            ]
          : []),
      ],
    },
    {
      kind: 'fields',
      rows: [
        { label: 'Razón social', value: data.issuer.businessName },
        { label: 'Condición frente al IVA', value: ISSUER_CONDITIONS[data.issuer.taxCondition] },
        { label: 'Inicio de actividades', value: dayText(data.issuer.activityStartedOn) },
      ],
    },
    { kind: 'heading', text: 'Datos del receptor' },
    {
      kind: 'fields',
      rows: [
        {
          label: 'Apellido y nombre / Razón social',
          value: data.recipient.name ?? 'Consumidor Final',
        },
        {
          label: 'Documento',
          value: data.recipient.document
            ? documentText(data.recipient.document)
            : 'Sin identificar',
        },
        {
          label: 'Condición frente al IVA',
          value: RECIPIENT_CONDITIONS[data.recipient.taxCondition],
        },
        { label: 'Condición de venta', value: 'Contado' },
      ],
    },
    {
      kind: 'table',
      columns: [
        { header: 'Descripción', width: 6 },
        { header: 'Cant.', width: 1, align: 'right' },
        { header: 'Importe', width: 2, align: 'right' },
      ],
      rows: data.lines.map((line) => [line.description, '1', money$(line.amountCents)]),
    },
    { kind: 'fields', rows: totals },
    {
      kind: 'fields',
      rows: [
        { label: 'CAE N°', value: data.cae },
        ...(data.caeExpiresOn
          ? [{ label: 'Fecha de Vto. de CAE', value: dayText(data.caeExpiresOn) }]
          : []),
      ],
    },
    { kind: 'image', data: qr, size: 96, align: 'left' },
  ];

  return renderPdf({
    title: `${title.name} ${voucherNumber(data.pointOfSale, data.number)}`,
    branding: {
      organizationName: data.issuer.businessName,
      subtitle: `CUIT ${cuitText(data.issuer.cuit)} - ${ISSUER_CONDITIONS[data.issuer.taxCondition]} - ${data.issuer.address}`,
    },
    createdAt: data.issuedAt,
    subject: `${title.name} ${voucherNumber(data.pointOfSale, data.number)}`,
    blocks,
    ...(data.testDocument ? { watermark: TEST_DOCUMENT_MARK } : {}),
    footer: data.testDocument ? TEST_DOCUMENT_MARK : 'Comprobante autorizado',
  });
}
