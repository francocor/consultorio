import type { PaymentMethod } from '@consultorio/contracts';

import { cycle } from './shared.js';

/**
 * How each charge of the demonstration is paid, as plain data (pure: no database, no clock). The
 * seed turns a plan into calls to the real services, so the amounts that reach the screens and the
 * reports are the ones the rules of billing accept. Every amount is whole cents; the references
 * are voucher numbers that cannot be mistaken for a card number.
 */

export const SCENARIOS = [
  'cash_full',
  'debit_full',
  'credit_full',
  'transfer_full',
  'wallet_full',
  'link_full',
  'cash_partial',
  'split',
  'overpay',
  'refund',
  'pending',
  'void',
  'forgiven',
] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** What a visit that happened goes through, in the order the day brings them. */
export const SERVICE_CYCLE: readonly Scenario[] = [
  'cash_full',
  'debit_full',
  'cash_partial',
  'pending',
  'transfer_full',
  'credit_full',
  'split',
  'refund',
  'wallet_full',
  'void',
  'overpay',
  'link_full',
];

/** A fee for a visit that did not happen: mostly still owed, some paid, some forgiven. */
export const FEE_CYCLE: readonly Scenario[] = [
  'pending',
  'pending',
  'cash_full',
  'pending',
  'forgiven',
  'pending',
  'debit_full',
  'pending',
  'pending',
  'forgiven',
  'pending',
  'cash_full',
];

export function scenarioFor(index: number, kind: 'service' | 'late_fee'): Scenario {
  return cycle(kind === 'service' ? SERVICE_CYCLE : FEE_CYCLE, index);
}

export interface PaymentStep {
  method: PaymentMethod;
  amountCents: number;
  /** A voucher or transfer number. */
  reference?: string;
  /** Why a voucher number is used a second time. */
  overrideReason?: string;
  confirmCredit?: boolean;
}

export interface RefundStep {
  /** Which payment of the plan is given back, by position. */
  paymentIndex: number;
  amountCents: number;
  reason: string;
}

export interface PaymentPlan {
  payments: PaymentStep[];
  refunds: RefundStep[];
  /** The reason to void the charge instead of paying it. */
  void?: string;
}

const PESO = 100;
const serialOf = (serial: number) => String(serial).padStart(6, '0');

/** A round number of pesos, never below one peso nor above the limit. */
function wholePesos(cents: number, atMost: number): number {
  return Math.min(atMost, Math.max(PESO, Math.floor(cents / PESO) * PESO));
}

const REFERENCE: Partial<Record<PaymentMethod, string>> = {
  debit: 'CUPON',
  credit: 'CUPON',
  transfer: 'TRF',
  wallet: 'MP',
  payment_link: 'LINK',
};

function single(method: PaymentMethod, amountCents: number, serial: number): PaymentPlan {
  const prefix = REFERENCE[method];
  return {
    payments: [
      {
        method,
        amountCents,
        ...(prefix ? { reference: `${prefix}-${serialOf(serial)}` } : {}),
      },
    ],
    refunds: [],
  };
}

export function planFor(
  scenario: Scenario,
  input: { patientCents: number; serial: number },
): PaymentPlan {
  const { patientCents, serial } = input;
  switch (scenario) {
    case 'cash_full':
      return single('cash', patientCents, serial);
    case 'debit_full':
      return single('debit', patientCents, serial);
    case 'credit_full':
      return single('credit', patientCents, serial);
    case 'transfer_full':
      return single('transfer', patientCents, serial);
    case 'wallet_full':
      return single('wallet', patientCents, serial);
    case 'link_full':
      return single('payment_link', patientCents, serial);
    case 'cash_partial': {
      // A little under half, in whole pesos; a charge too small for that is paid whole.
      const part = wholePesos(patientCents * 0.45, patientCents - 1);
      return part < 1 || part >= patientCents
        ? single('cash', patientCents, serial)
        : single('cash', part, serial);
    }
    case 'split': {
      if (patientCents < 2 * PESO) return single('debit', patientCents, serial);
      const first = wholePesos(patientCents / 2, patientCents - PESO);
      const reference = `CUPON-${serialOf(serial)}`;
      return {
        payments: [
          { method: 'debit', amountCents: first, reference },
          {
            method: 'debit',
            amountCents: patientCents - first,
            reference,
            overrideReason: 'Un solo cupón de la terminal dividido en dos cobros',
          },
        ],
        refunds: [],
      };
    }
    case 'overpay':
      return {
        payments: [{ method: 'cash', amountCents: patientCents + 50 * PESO, confirmCredit: true }],
        refunds: [],
      };
    case 'refund': {
      const refunded = wholePesos(patientCents * 0.25, patientCents - 1);
      return {
        payments: [{ method: 'cash', amountCents: patientCents }],
        refunds: [
          {
            paymentIndex: 0,
            amountCents: refunded,
            reason: 'Devolución parcial: estudio indicado y no realizado',
          },
        ],
      };
    }
    case 'pending':
      return { payments: [], refunds: [] };
    case 'void':
      return { payments: [], refunds: [], void: 'Cobro cargado dos veces por un error de carga' };
    case 'forgiven':
      return {
        payments: [],
        refunds: [],
        void: 'Se perdonó el cargo: el paciente avisó con anticipación',
      };
  }
}
