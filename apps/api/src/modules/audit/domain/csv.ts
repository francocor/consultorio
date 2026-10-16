/** First characters that make a spreadsheet read a cell as a formula (OWASP, CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell (RFC 4180). A cell that begins like a formula gets a leading apostrophe, so opening
 * the export in a spreadsheet never runs something a user typed into an audited field.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvRow(cells: readonly (string | number | boolean | null | undefined)[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}
