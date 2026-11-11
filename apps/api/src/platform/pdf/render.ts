import type { DocumentProps } from '@react-pdf/renderer';
import { createElement, type ReactElement } from 'react';

/**
 * The shared PDF frame of the worker (design section 6, S4.00 task 4.5): every document the product
 * renders (a billing export, an invoice, a report) goes through it, so they share the header with
 * the branding of the organization, the footer with page numbers, the fonts and the optional
 * "simulated" mark. A caller describes WHAT the document says with blocks; the frame decides how it
 * looks, so a rendering library is a detail that can change in one place.
 *
 * - Deterministic: the same input renders the same bytes. The creation date is an input, never
 *   "now", and nothing random goes into the file, so a golden test can compare readings of it.
 * - Fonts: the standard Helvetica of the PDF format. Its WinAnsi encoding draws every character of
 *   Spanish (accents, eñe, ¿, ¡) and the euro sign; `pdfSafeText` replaces what it cannot draw.
 * - The library is loaded when the first document is rendered, so the API process that never
 *   renders one does not pay for it (and starting it stays quick).
 */

export interface PdfBranding {
  organizationName: string;
  /** A line under the name: address, tax id, whatever the document must show. */
  subtitle?: string;
  /** "#RRGGBB": the rule under the header. Defaults to a dark neutral. */
  accentColor?: string;
  /** PNG or JPEG bytes of the logo, shown at the right of the header. */
  logo?: Buffer;
}

export type PdfBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string; muted?: boolean }
  /** Label and value pairs, one per line. */
  | { kind: 'fields'; rows: readonly { label: string; value: string }[] }
  | {
      kind: 'table';
      /** `width` is a weight: the columns share the page in proportion to it. */
      columns: readonly { header: string; width: number; align?: 'left' | 'right' }[];
      rows: readonly (readonly string[])[];
    }
  /** PNG or JPEG bytes (the QR of an invoice), drawn `size` points wide and high. */
  | { kind: 'image'; data: Buffer; size: number; align?: 'left' | 'center' | 'right' }
  | { kind: 'spacer'; height?: number };

export interface RenderPdfInput {
  title: string;
  branding: PdfBranding;
  /** Goes into the file as its creation and modification date. Never "now": it keeps bytes stable. */
  createdAt: Date;
  subject?: string;
  blocks: readonly PdfBlock[];
  /** A diagonal mark on every page, for a simulated document ("documento de prueba sin validez fiscal"). */
  watermark?: string;
  /** Text at the left of the footer; the page number is always at the right. */
  footer?: string;
}

/** The characters of Windows-1252 above 0x7F that are not in Latin-1. */
const WIN_ANSI_EXTRAS = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

/**
 * Text the standard fonts can draw. A character they cannot draw becomes a question mark (the
 * reader sees that something is missing; garbage glyphs would look like data), and control
 * characters other than the line break are dropped.
 */
export function pdfSafeText(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\n') out += char;
    else if (char === '\t') out += ' ';
    else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    else if (code <= 0x7e || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRAS.includes(char))
      out += char;
    else out += '?';
  }
  return out;
}

const DEFAULT_ACCENT = '#1f2937';
const MUTED = '#6b7280';
const RULE = '#d1d5db';
const PAGE_PADDING = 40;

function imageSource(data: Buffer) {
  const isPng = data.subarray(1, 4).toString('latin1') === 'PNG';
  return { data, format: isPng ? ('png' as const) : ('jpg' as const) };
}

/** Renders the document. Rejects when the library cannot draw it (for example a broken image). */
export async function renderPdf(input: RenderPdfInput): Promise<Buffer> {
  const { Document, Font, Page, Text, View, Image, renderToBuffer } =
    await import('@react-pdf/renderer');
  // A word is never split with a hyphen: an amount, a name or a mark must read as written.
  Font.registerHyphenationCallback((word) => [word]);
  const safe = pdfSafeText;
  const accent = input.branding.accentColor ?? DEFAULT_ACCENT;

  const block = (item: PdfBlock, key: number): ReactElement => {
    switch (item.kind) {
      case 'heading':
        return createElement(
          Text,
          { key, style: { fontSize: 12, fontWeight: 'bold', marginTop: 10, marginBottom: 6 } },
          safe(item.text),
        );
      case 'paragraph':
        return createElement(
          Text,
          {
            key,
            style: {
              fontSize: 10,
              lineHeight: 1.4,
              marginBottom: 6,
              ...(item.muted === true ? { color: MUTED } : {}),
            },
          },
          safe(item.text),
        );
      case 'fields':
        return createElement(
          View,
          { key, style: { marginBottom: 8 } },
          ...item.rows.map((row, index) =>
            createElement(
              View,
              { key: index, style: { flexDirection: 'row', marginBottom: 2 }, wrap: false },
              createElement(
                Text,
                { style: { width: '32%', fontSize: 10, color: MUTED } },
                safe(row.label),
              ),
              createElement(Text, { style: { width: '68%', fontSize: 10 } }, safe(row.value)),
            ),
          ),
        );
      case 'table': {
        const total = item.columns.reduce((sum, column) => sum + column.width, 0);
        const cell = (text: string, index: number, header: boolean) => {
          const column = item.columns[index];
          return createElement(
            Text,
            {
              key: index,
              style: {
                width: `${String(((column?.width ?? 1) / total) * 100)}%`,
                paddingVertical: 4,
                paddingHorizontal: 4,
                fontSize: 9,
                textAlign: column?.align ?? 'left',
                ...(header ? { fontWeight: 'bold' } : {}),
              },
            },
            safe(text),
          );
        };
        return createElement(
          View,
          { key, style: { marginTop: 4, marginBottom: 8 } },
          // `fixed` repeats the header row at the top of every page the table runs over.
          createElement(
            View,
            {
              fixed: true,
              style: {
                flexDirection: 'row',
                backgroundColor: '#f3f4f6',
                borderBottomWidth: 1,
                borderBottomColor: RULE,
              },
            },
            ...item.columns.map((column, index) => cell(column.header, index, true)),
          ),
          ...item.rows.map((row, rowIndex) =>
            createElement(
              View,
              {
                key: rowIndex,
                wrap: false,
                style: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: RULE },
              },
              ...item.columns.map((_, index) => cell(row[index] ?? '', index, false)),
            ),
          ),
        );
      }
      case 'image':
        return createElement(
          View,
          {
            key,
            wrap: false,
            style: {
              marginVertical: 6,
              alignItems:
                item.align === 'right'
                  ? 'flex-end'
                  : item.align === 'center'
                    ? 'center'
                    : 'flex-start',
            },
          },
          createElement(Image, {
            src: imageSource(item.data),
            style: { width: item.size, height: item.size },
          }),
        );
      case 'spacer':
        return createElement(View, { key, style: { height: item.height ?? 12 } });
    }
  };

  const header = createElement(
    View,
    {
      style: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottomWidth: 1.5,
        borderBottomColor: accent,
        paddingBottom: 8,
        marginBottom: 12,
      },
    },
    createElement(
      View,
      { style: { flexGrow: 1 } },
      createElement(
        Text,
        { style: { fontSize: 14, fontWeight: 'bold' } },
        safe(input.branding.organizationName),
      ),
      input.branding.subtitle === undefined
        ? null
        : createElement(
            Text,
            { style: { fontSize: 8, color: MUTED, marginTop: 2 } },
            safe(input.branding.subtitle),
          ),
    ),
    input.branding.logo === undefined
      ? null
      : createElement(Image, {
          src: imageSource(input.branding.logo),
          style: { height: 36, objectFit: 'contain' },
        }),
  );

  const footer = createElement(
    View,
    {
      fixed: true,
      style: {
        position: 'absolute',
        bottom: 20,
        left: PAGE_PADDING,
        right: PAGE_PADDING,
        flexDirection: 'row',
        justifyContent: 'space-between',
        borderTopWidth: 0.5,
        borderTopColor: RULE,
        paddingTop: 4,
      },
    },
    createElement(
      Text,
      { style: { fontSize: 8, color: MUTED } },
      safe(input.footer ?? input.branding.organizationName),
    ),
    createElement(Text, {
      style: { fontSize: 8, color: MUTED },
      render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
        `Página ${String(pageNumber)} de ${String(totalPages)}`,
    }),
  );

  const watermark =
    input.watermark === undefined
      ? null
      : createElement(
          View,
          {
            fixed: true,
            style: {
              position: 'absolute',
              top: 330,
              left: 0,
              right: 0,
              alignItems: 'center',
              transform: 'rotate(-28deg)',
              opacity: 0.2,
            },
          },
          createElement(
            Text,
            {
              style: {
                fontSize: 30,
                fontWeight: 'bold',
                color: '#b91c1c',
                textAlign: 'center',
                width: 440,
              },
            },
            safe(input.watermark),
          ),
        );

  const page = createElement(
    Page,
    { size: 'A4', style: { padding: PAGE_PADDING, paddingBottom: 56, fontFamily: 'Helvetica' } },
    header,
    createElement(
      Text,
      { style: { fontSize: 16, fontWeight: 'bold', marginBottom: 8 } },
      safe(input.title),
    ),
    ...input.blocks.map(block),
    watermark,
    footer,
  );

  const document = createElement(Document, {
    title: safe(input.title),
    author: safe(input.branding.organizationName),
    ...(input.subject === undefined ? {} : { subject: safe(input.subject) }),
    creator: 'Consulvia',
    producer: 'Consulvia',
    language: 'es-AR',
    creationDate: input.createdAt,
    modificationDate: input.createdAt,
    children: page,
  } as DocumentProps);

  return renderToBuffer(document);
}
