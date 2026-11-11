/**
 * The text the system writes on the lines it makes itself. A charge line carries a description
 * because exports and invoices print it, so it is stored, in es-AR (the product's language; the
 * screens translate the kind of the line with their own catalog and show the stored text only for
 * lines a person wrote).
 */

const MAX_DESCRIPTION = 200;

const fit = (text: string) =>
  text.length <= MAX_DESCRIPTION ? text : text.slice(0, MAX_DESCRIPTION);

export const LINE_LABELS = {
  copago: 'Copago',
  plus: 'Plus',
  lateFee: 'Cargo por ausencia o cancelación tardía',
  coverage: (payerName: string) => fit(`Cobertura ${payerName}`),
} as const;
