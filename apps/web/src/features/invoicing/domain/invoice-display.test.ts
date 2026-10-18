import type { ChargeDto, InvoiceDto } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import {
  ageParts,
  canInvoiceCharge,
  creditableCents,
  issuableLines,
  isCreditNote,
  needsCuit,
  voucherNumber,
} from './invoice-display.js';

const line = (
  id: string,
  portion: 'patient' | 'payer',
  amount: number,
  invoiced = 0,
  kind: ChargeDto['lines'][number]['kind'] = 'service',
): ChargeDto['lines'][number] => ({
  id,
  position: 1,
  kind,
  portion,
  description: 'Consulta',
  amountCents: amount as never,
  invoicedCents: invoiced as never,
});

const chargeWith = (
  lines: ChargeDto['lines'],
  status: ChargeDto['status'] = 'pending',
): Pick<ChargeDto, 'lines' | 'status'> => ({ lines, status });

describe('the number of a voucher', () => {
  it('is the point of sale and the number, padded as AFIP prints them', () => {
    expect(voucherNumber(1, 77)).toBe('0001-00000077');
    expect(voucherNumber(12345, 123456789)).toBe('12345-123456789');
  });

  it('is empty while the voucher has no number yet', () => {
    expect(voucherNumber(1, null)).toBe('');
  });
});

describe('how long ago an invoice was asked for', () => {
  it('counts minutes under an hour, hours under a day and days after', () => {
    expect(ageParts(0)).toEqual({ unit: 'minutes', count: 0 });
    expect(ageParts(59)).toEqual({ unit: 'minutes', count: 59 });
    expect(ageParts(60)).toEqual({ unit: 'hours', count: 1 });
    expect(ageParts(25 * 60)).toEqual({ unit: 'hours', count: 25 });
    expect(ageParts(47 * 60 + 59)).toEqual({ unit: 'hours', count: 47 });
    expect(ageParts(48 * 60)).toEqual({ unit: 'days', count: 2 });
    expect(ageParts(10 * 24 * 60)).toEqual({ unit: 'days', count: 10 });
  });
});

describe('the lines of a charge that an invoice can still cover', () => {
  const charge = chargeWith([
    line('a', 'payer', 1_500_000, 0, 'payer_coverage'),
    line('b', 'patient', 300_000, 100_000, 'copago'),
    line('c', 'patient', 200_000, 200_000, 'plus'),
  ]);

  it('are the lines of the portion with something left, with what is left', () => {
    expect(issuableLines(charge, 'patient')).toEqual([
      expect.objectContaining({ id: 'b', leftCents: 200_000 }),
    ]);
    expect(issuableLines(charge, 'payer')).toEqual([
      expect.objectContaining({ id: 'a', leftCents: 1_500_000 }),
    ]);
  });

  it('are none for a voided charge, which is final', () => {
    expect(issuableLines(chargeWith(charge.lines, 'voided'), 'patient')).toEqual([]);
    expect(canInvoiceCharge(chargeWith(charge.lines, 'voided'))).toBe(false);
  });

  it('say whether the charge can be invoiced at all', () => {
    expect(canInvoiceCharge(charge)).toBe(true);
    expect(canInvoiceCharge(chargeWith([line('x', 'patient', 100, 100)]))).toBe(false);
    expect(canInvoiceCharge(chargeWith([]))).toBe(false);
  });
});

describe('what a Factura A asks for', () => {
  it('needs the CUIT of the recipient only for type A', () => {
    expect(needsCuit('FA')).toBe(true);
    expect(needsCuit('FB')).toBe(false);
    expect(needsCuit('FC')).toBe(false);
    expect(needsCuit(undefined)).toBe(false);
  });
});

describe('credit notes', () => {
  const invoice = (
    overrides: Partial<InvoiceDto>,
  ): Pick<InvoiceDto, 'kind' | 'totalCents' | 'creditedCents' | 'status'> => ({
    kind: 'invoice',
    totalCents: 2_000_000,
    creditedCents: 0,
    status: 'issued',
    ...overrides,
  });

  it('tells a credit note from an invoice', () => {
    expect(isCreditNote(invoice({ kind: 'credit_note' }))).toBe(true);
    expect(isCreditNote(invoice({}))).toBe(false);
  });

  it('can credit what is left of an issued or registered invoice', () => {
    expect(creditableCents(invoice({ creditedCents: 500_000 }))).toBe(1_500_000);
    expect(creditableCents(invoice({ status: 'manual' }))).toBe(2_000_000);
  });

  it('can credit nothing of a pending invoice, a rejected one, a note or a fully credited invoice', () => {
    expect(creditableCents(invoice({ status: 'pending' }))).toBe(0);
    expect(creditableCents(invoice({ status: 'rejected' }))).toBe(0);
    expect(creditableCents(invoice({ kind: 'credit_note' }))).toBe(0);
    expect(creditableCents(invoice({ creditedCents: 2_000_000 }))).toBe(0);
  });
});
