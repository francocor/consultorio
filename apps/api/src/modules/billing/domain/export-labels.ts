import type { ChargeStatus, PaymentMethod } from '@consultorio/contracts';

/**
 * The words of the exports, in es-AR. An export is a document the organization keeps and prints, so
 * its headers are written by the server in the language of the product (the screens translate their
 * own text with the catalogs of the web app). Nothing here is clinical.
 */

export const STATUS_LABELS: Record<ChargeStatus, string> = {
  pending: 'Pendiente',
  partially_paid: 'Pago parcial',
  paid: 'Pagado',
  voided: 'Anulado',
};

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Efectivo',
  debit: 'Débito',
  credit: 'Crédito',
  transfer: 'Transferencia',
  wallet: 'Billetera virtual',
  payment_link: 'Link de pago',
};

export const MOVEMENT_LABELS = {
  payment: 'Pago',
  refund: 'Devolución',
  correction: 'Corrección',
} as const;

export const PRIVATE_LABEL = 'Particular';

export const EXPORT_TITLES = {
  charges: 'Cobros',
  payments: 'Pagos',
  payer_settlement: 'Liquidación a obras sociales y prepagas',
} as const;

export const EXPORT_FILE_BASES = {
  charges: 'cobros',
  payments: 'pagos',
  payer_settlement: 'liquidacion-obras-sociales',
} as const;
