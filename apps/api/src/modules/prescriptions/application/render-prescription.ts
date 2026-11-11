import { renderPdf, type PdfBlock } from '../../../platform/pdf/render.js';
import type { PrescriptionContent } from '../domain/prescription.js';

/**
 * The document of a prescription (e-prescription, "Prescription content"): the data the provider
 * requires, the identifier it gave, and the medications by generic name. It goes through the shared
 * PDF frame, which draws the mark of a simulated document. Everything it prints comes from the
 * record of the prescription, which never changes once the provider confirmed it, so the same
 * prescription renders the same bytes.
 */

export const SIMULATED_MARK = 'Receta electrónica simulada, sin validez legal';

export interface PrescriptionDocumentData {
  content: PrescriptionContent;
  /** The identifier the provider gave (or the one the professional typed in). */
  externalId: string;
  /** Goes into the file as its creation date: never "now", so the bytes are stable. */
  issuedAt: Date;
  organizationName: string;
  /** A simulator is behind it: the document says so on every page. */
  simulated: boolean;
  /** The professional issued it on the provider's own site and registered the identifier here. */
  registeredManually: boolean;
}

/** `2026-10-19` as `19/10/2026`. */
function dayText(day: string): string {
  const [year = '', month = '', date = ''] = day.split('-');
  return `${date}/${month}/${year}`;
}

/** Renders the PDF of a prescription the provider confirmed. */
export function renderPrescription(data: PrescriptionDocumentData): Promise<Buffer> {
  const { content } = data;
  const documentLabel = content.patient.documentType === 'dni' ? 'DNI' : 'Pasaporte';
  const coverage = content.patient.coverage;

  const blocks: PdfBlock[] = [
    ...(data.simulated ? [{ kind: 'paragraph', text: SIMULATED_MARK } as const] : []),
    {
      kind: 'fields',
      rows: [
        { label: 'Identificador', value: data.externalId },
        { label: 'Fecha', value: dayText(content.date) },
      ],
    },
    { kind: 'heading', text: 'Paciente' },
    {
      kind: 'fields',
      rows: [
        { label: 'Nombre y apellido', value: content.patient.fullName },
        { label: documentLabel, value: content.patient.documentNumber },
        {
          label: 'Cobertura',
          value:
            coverage === null
              ? 'Sin cobertura'
              : coverage.planName === null
                ? coverage.payerName
                : `${coverage.payerName} - ${coverage.planName}`,
        },
      ],
    },
    { kind: 'heading', text: 'Profesional' },
    {
      kind: 'fields',
      rows: [
        { label: 'Nombre y apellido', value: content.prescriber.fullName },
        {
          label: 'Matrícula',
          value: `${content.prescriber.matricula} (${content.prescriber.jurisdiction})`,
        },
        ...(content.prescriber.specialty === null
          ? []
          : [{ label: 'Especialidad', value: content.prescriber.specialty }]),
      ],
    },
    { kind: 'heading', text: 'Medicamentos' },
    {
      kind: 'table',
      columns: [
        { header: 'Nombre genérico', width: 3 },
        { header: 'Dosis', width: 2 },
        { header: 'Forma', width: 2 },
        { header: 'Cant.', width: 1, align: 'right' },
        { header: 'Indicaciones', width: 4 },
      ],
      rows: content.items.map((item) => [
        item.genericName,
        item.dose,
        item.form,
        String(item.quantity),
        item.instructions,
      ]),
    },
    ...(data.registeredManually
      ? [
          {
            kind: 'paragraph',
            text: 'Emitida por el profesional en el sitio del proveedor; el identificador fue registrado manualmente.',
            muted: true,
          } as const,
        ]
      : []),
  ];

  return renderPdf({
    title: 'Receta electrónica',
    branding: { organizationName: data.organizationName },
    createdAt: data.issuedAt,
    subject: 'Receta electrónica (Ley 27.553)',
    blocks,
    ...(data.simulated ? { watermark: SIMULATED_MARK } : {}),
    footer: 'Receta electrónica - Ley 27.553',
  });
}
