import { renderPdf, type PdfBlock } from '../../../platform/pdf/render.js';
import type { ExportKind } from '../application/export-registry.js';

import type { PackageReport } from './package-content.js';
import type { ZipEntry } from './zip.js';

/**
 * The two files that close every package: `manifiesto.json`, the structured account of what the zip
 * holds (every section with its number of rows, every attached file with whether it arrived intact,
 * and the secret fields that were left out), and `resumen.pdf`, the same account in a form a person
 * reads. The data itself is in the JSON files of each module; the PDF is the index to them. The
 * texts are the product's own language (es-AR), like every document it renders.
 */

export interface SummaryInput {
  kind: ExportKind;
  organizationName: string;
  generatedAt: Date;
  /** The professional a clinical package is made for. Never set on the administrative one. */
  professionalName?: string | null;
  report: PackageReport;
}

const TITLES: Record<ExportKind, string> = {
  administrative: 'Exportación administrativa',
  clinical: 'Exportación clínica',
};

const INTRODUCTIONS: Record<ExportKind, string> = {
  administrative:
    'Este paquete reúne la información administrativa de la organización: su configuración, el personal, los datos de los pacientes y su cobertura, la agenda y la asistencia, los cobros y las facturas, y el registro de auditoría. No contiene información clínica.',
  clinical:
    'Este paquete reúne los registros clínicos de los pacientes que usted atiende: evoluciones y sus agregados, anamnesis, documentos clínicos, recetas y consentimientos. Es personal: solo la persona a quien está dirigido puede descargarlo.',
};

/** `2031-05-31`: the day, in the form that sorts and needs no locale. */
const dayOf = (at: Date) => at.toISOString().slice(0, 10);

export function packageFileName(kind: ExportKind, at: Date): string {
  return `exportacion-${kind === 'clinical' ? 'clinica' : 'administrativa'}-${dayOf(at).replaceAll('-', '')}.zip`;
}

function manifestOf(input: SummaryInput): string {
  return `${JSON.stringify(
    {
      format: 1,
      kind: input.kind,
      generatedAt: input.generatedAt.toISOString(),
      organization: input.organizationName,
      sections: input.report.sections,
      attachments: input.report.attachments,
      redactedFields: input.report.redactedKeys,
    },
    null,
    2,
  )}\n`;
}

function blocksOf(input: SummaryInput): PdfBlock[] {
  const { report } = input;
  const included = report.attachments.filter((file) => file.status === 'included').length;
  const problems = report.attachments.length - included;
  const rows = report.sections.map((section): readonly string[] => [
    section.contributor,
    section.section,
    section.rows === null ? '—' : String(section.rows),
  ]);
  return [
    { kind: 'paragraph', text: INTRODUCTIONS[input.kind] },
    {
      kind: 'fields',
      rows: [
        { label: 'Organización', value: input.organizationName },
        ...(input.professionalName
          ? [{ label: 'Profesional', value: input.professionalName }]
          : []),
        { label: 'Generado el', value: dayOf(input.generatedAt) },
        { label: 'Archivos adjuntos incluidos', value: String(included) },
        ...(problems > 0
          ? [{ label: 'Archivos adjuntos con problemas', value: String(problems) }]
          : []),
      ],
    },
    { kind: 'heading', text: 'Contenido' },
    {
      kind: 'table',
      columns: [
        { header: 'Módulo', width: 3 },
        { header: 'Sección', width: 4 },
        { header: 'Registros', width: 2, align: 'right' },
      ],
      rows,
    },
    {
      kind: 'paragraph',
      muted: true,
      text: 'Cada sección está en un archivo JSON dentro de la carpeta de su módulo; los archivos adjuntos están en la carpeta files de cada módulo. El archivo manifiesto.json lista todo lo anterior.',
    },
  ];
}

/** The closing entries of a package. */
export async function summaryEntries(input: SummaryInput): Promise<ZipEntry[]> {
  const pdf = await renderPdf({
    title: TITLES[input.kind],
    branding: { organizationName: input.organizationName },
    createdAt: input.generatedAt,
    blocks: blocksOf(input),
  });
  return [
    {
      name: 'manifiesto.json',
      modifiedAt: input.generatedAt,
      body: Buffer.from(manifestOf(input)),
    },
    { name: 'resumen.pdf', modifiedAt: input.generatedAt, body: pdf },
  ];
}
