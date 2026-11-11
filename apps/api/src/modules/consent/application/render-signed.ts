import sharp from 'sharp';

import { renderPdf, type PdfBlock } from '../../../platform/pdf/render.js';

import type { SignedRecord } from './signed-record.js';

/** Everything the printable record shows besides the record itself. */
export interface SignedDocumentContext {
  organizationName: string;
  patientName: string;
  /** The time zone the dates are written in (the organization's). */
  timeZone: string;
}

/** The side of the square the signature is drawn in. The frame only draws square images. */
const MARK_SIZE = 220;

const METHODS = {
  in_person: 'En persona, en el dispositivo del consultorio',
  portal: 'Desde el portal del paciente',
};

function dateText(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone,
  }).format(date);
}

/** The paragraphs of a text, split at blank lines; a line break inside one is kept. */
function paragraphsOf(text: string): PdfBlock[] {
  return text
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim() !== '')
    .map((paragraph) => ({ kind: 'paragraph', text: paragraph }));
}

/**
 * The drawn signature, placed on a white square: the PDF frame draws images as squares, and a
 * stretched signature would not be the one the signer drew.
 */
async function squareMark(dataUrl: string): Promise<Buffer> {
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  return sharp(bytes)
    .flatten({ background: '#ffffff' })
    .resize(MARK_SIZE, MARK_SIZE, { fit: 'contain', background: '#ffffff' })
    .png()
    .toBuffer();
}

/**
 * The printable record of a signed consent (informed-consent, "Signature capture and binding": a
 * signed consent MUST be rendered as a printable document with the signature and evidence). It
 * shows the exact text that was signed, who signed, how and when, the signature, the context
 * evidence and both fingerprints, and the revocation when there is one. It goes through the shared
 * PDF frame of the product, with the date of the signature as its creation date, so the same
 * record renders the same bytes.
 */
export async function renderSignedConsent(
  record: SignedRecord,
  context: SignedDocumentContext,
): Promise<Buffer> {
  const { request, version, signature, payload, revocation } = record;
  const signer =
    signature.signerKind === 'representative' && payload.representative
      ? `Representante legal: ${payload.representative.name}, documento ${payload.representative.nationalId}, vínculo: ${payload.representative.relation}`
      : 'El propio paciente';

  const blocks: PdfBlock[] = [
    // A record that no longer matches its fingerprint says so before anything else (JD-S5 R1-B-W7):
    // whoever prints it must not take it for the document that was signed.
    ...(record.fingerprintValid
      ? []
      : ([
          { kind: 'heading', text: 'ATENCIÓN: falló la verificación de integridad' },
          {
            kind: 'paragraph',
            text: 'Los datos guardados de esta firma o el texto firmado no coinciden con la huella que se calculó cuando se firmó. Este documento no prueba lo que firmó la persona: avise a la persona responsable de la organización.',
          },
        ] satisfies PdfBlock[])),
    ...paragraphsOf(version.body),
    { kind: 'heading', text: 'Firma' },
    {
      kind: 'fields',
      rows: [
        { label: 'Paciente', value: context.patientName },
        { label: 'Firmó', value: signer },
        ...(payload.signerName === undefined
          ? []
          : [{ label: 'Nombre completo del firmante', value: payload.signerName }]),
        { label: 'Fecha y hora', value: dateText(signature.signedAt, context.timeZone) },
        {
          label: 'Modalidad',
          value: METHODS[signature.method as keyof typeof METHODS],
        },
        { label: 'Versión del texto', value: String(version.versionNumber) },
        { label: 'Aceptación expresa', value: 'Sí, el firmante aceptó el texto completo' },
      ],
    },
  ];

  if (payload.mark.kind === 'drawn') {
    // A drawing is decoded before it is stored, so this does not fail for a new record; a record
    // from before that check, whose image does not decode, still prints, and says so.
    const image = await squareMark(payload.mark.value).catch(() => null);
    blocks.push(
      image === null
        ? { kind: 'paragraph', text: 'Firma dibujada: la imagen guardada no se pudo leer.' }
        : { kind: 'image', data: image, size: MARK_SIZE / 2 },
    );
  } else {
    blocks.push({ kind: 'paragraph', text: `Firma (nombre escrito): ${payload.mark.value}` });
  }

  blocks.push(
    { kind: 'heading', text: 'Constancia de la firma' },
    {
      kind: 'fields',
      rows: [
        { label: 'Huella del texto', value: version.contentHash },
        { label: 'Huella de la firma', value: signature.contentFingerprint },
        { label: 'Dirección IP', value: payload.evidence.ip ?? 'No disponible' },
        { label: 'Dispositivo', value: payload.evidence.userAgent ?? 'No disponible' },
        { label: 'Identificador del pedido', value: request.id },
      ],
    },
    {
      kind: 'paragraph',
      muted: true,
      text: 'Las huellas son códigos SHA-256 calculados sobre el texto firmado y sobre los datos de la firma. Si el registro se modificara, no coincidirían.',
    },
  );

  if (revocation) {
    blocks.push(
      { kind: 'heading', text: 'Revocación' },
      {
        kind: 'fields',
        rows: [
          { label: 'Fecha y hora', value: dateText(revocation.row.revokedAt, context.timeZone) },
          {
            label: 'Modalidad',
            value:
              revocation.row.channel === 'portal'
                ? 'Desde el portal del paciente'
                : 'Registrada en persona por el consultorio',
          },
          ...(revocation.reason === null ? [] : [{ label: 'Motivo', value: revocation.reason }]),
        ],
      },
      {
        kind: 'paragraph',
        muted: true,
        text: 'La revocación no modifica la firma original ni deshace lo realizado mientras el consentimiento estuvo vigente.',
      },
    );
  }

  return renderPdf({
    title: version.title,
    subject: 'Consentimiento informado firmado',
    branding: { organizationName: context.organizationName },
    createdAt: signature.signedAt,
    blocks,
    footer: `${context.organizationName} · Consentimiento informado`,
  });
}
