import {
  CHARGE_LINE_KINDS,
  CHARGE_LINE_PORTIONS,
  CHARGE_STATUSES,
  money,
  type ChargeLineKind,
  type ChargeLinePortion,
  type ChargeStatus,
} from '@consultorio/contracts';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { charge, chargeLine } from '../../../db/schema/billing-charges.js';
import { appointment } from '../../../db/schema/scheduling.js';
import { location } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { summarizeCharge } from '../domain/charge-status.js';

import { localDay } from './common.js';

/**
 * The charge lines as the invoicing module (track C) uses them. Invoices cover lines of one or
 * several charges, and a line can be invoiced in parts (e-invoicing-afip); billing owns the lines
 * and exposes them here, through its index, so invoicing never reads the tables.
 */

export interface ChargeLineForInvoicing {
  id: string;
  chargeId: string;
  /** A voided charge is final: no invoice may cover its lines. */
  chargeStatus: ChargeStatus;
  patientId: string;
  appointmentId: string;
  locationId: string;
  professionalId: string;
  /** The payer the charge was made for; null for a private patient. */
  tenantPayerId: string | null;
  position: number;
  kind: ChargeLineKind;
  portion: ChargeLinePortion;
  description: string;
  amountCents: number;
  /** How much of the line invoices cover so far. */
  invoicedCents: number;
  /** What an invoice may still cover: the amount minus what is invoiced. */
  uninvoicedCents: number;
}

function oneOf<T extends string>(values: readonly T[], value: string): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`unexpected value "${value}" in a charge line`);
  return found;
}

const lineColumns = {
  line: chargeLine,
  chargeStatus: charge.status,
  patientId: charge.patientId,
  appointmentId: charge.appointmentId,
  locationId: charge.locationId,
  professionalId: charge.professionalId,
  tenantPayerId: charge.tenantPayerId,
};

function lineQuery(tx: Tx) {
  return tx
    .select(lineColumns)
    .from(chargeLine)
    .innerJoin(charge, eq(charge.id, chargeLine.chargeId));
}

type LineView = Awaited<ReturnType<typeof lineQuery>>[number];

function toLine(view: LineView): ChargeLineForInvoicing {
  const { line } = view;
  return {
    id: line.id,
    chargeId: line.chargeId,
    chargeStatus: oneOf(CHARGE_STATUSES, view.chargeStatus),
    patientId: view.patientId,
    appointmentId: view.appointmentId,
    locationId: view.locationId,
    professionalId: view.professionalId,
    tenantPayerId: view.tenantPayerId,
    position: line.position,
    kind: oneOf(CHARGE_LINE_KINDS, line.kind),
    portion: oneOf(CHARGE_LINE_PORTIONS, line.portion),
    description: line.description,
    amountCents: money(line.amountCents),
    invoicedCents: money(line.invoicedCents),
    uninvoicedCents: money(line.amountCents - line.invoicedCents),
  };
}

/**
 * Reads lines by id, in the order of their ids (so two invoices that lock the same lines always
 * lock them in the same order and cannot deadlock). With `lock: true` the rows are locked FOR UPDATE
 * until the end of the transaction: the invoice is built over what it read.
 */
export async function readChargeLines(
  tx: Tx,
  lineIds: readonly string[],
  options: { lock?: boolean } = {},
): Promise<ChargeLineForInvoicing[]> {
  if (lineIds.length === 0) return [];
  const base = lineQuery(tx)
    .where(inArray(chargeLine.id, [...lineIds]))
    .orderBy(asc(chargeLine.id));
  const views = await (options.lock ? base.for('update', { of: chargeLine }) : base);
  return views.map(toLine);
}

/** All the lines of some charges, by charge and position. */
export async function readChargeLinesOfCharges(
  tx: Tx,
  chargeIds: readonly string[],
): Promise<ChargeLineForInvoicing[]> {
  if (chargeIds.length === 0) return [];
  const views = await lineQuery(tx)
    .where(inArray(chargeLine.chargeId, [...chargeIds]))
    .orderBy(asc(chargeLine.chargeId), asc(chargeLine.position));
  return views.map(toLine);
}

export interface ChargeForInvoicing {
  id: string;
  status: ChargeStatus;
  patientId: string;
  appointmentId: string;
  locationId: string;
  professionalId: string;
  tenantPayerId: string | null;
  /** What the invoice prints as the service (the name of the appointment type). */
  appointmentTypeName: string;
  /** The day of the service in the time zone of the location (`YYYY-MM-DD`). */
  serviceDate: string;
  totalCents: number;
  patientCents: number;
  payerCents: number;
  invoicedCents: number;
}

/** The facts of some charges that an invoice needs, without the payments and without the lines. */
export async function readChargesForInvoicing(
  tx: Tx,
  chargeIds: readonly string[],
): Promise<ChargeForInvoicing[]> {
  if (chargeIds.length === 0) return [];
  const rows = await tx
    .select({
      row: charge,
      startsAt: appointment.startsAt,
      timeZone: location.timeZone,
    })
    .from(charge)
    .innerJoin(appointment, eq(appointment.id, charge.appointmentId))
    .innerJoin(location, eq(location.id, charge.locationId))
    .where(inArray(charge.id, [...chargeIds]))
    .orderBy(asc(charge.id));
  const lines = await tx
    .select()
    .from(chargeLine)
    .where(
      inArray(
        chargeLine.chargeId,
        rows.map((entry) => entry.row.id),
      ),
    );

  return rows.map(({ row, startsAt, timeZone }) => {
    const summary = summarizeCharge(
      lines.filter((line) => line.chargeId === row.id),
      0,
    );
    const snapshot = row.snapshot as { appointmentTypeName?: unknown };
    return {
      id: row.id,
      status: oneOf(CHARGE_STATUSES, row.status),
      patientId: row.patientId,
      appointmentId: row.appointmentId,
      locationId: row.locationId,
      professionalId: row.professionalId,
      tenantPayerId: row.tenantPayerId,
      appointmentTypeName:
        typeof snapshot.appointmentTypeName === 'string' ? snapshot.appointmentTypeName : '',
      serviceDate: localDay(startsAt, timeZone),
      totalCents: summary.totalCents,
      patientCents: summary.patientCents,
      payerCents: summary.payerCents,
      invoicedCents: summary.invoicedCents,
    };
  });
}

export type ChargeLineAdjustmentReason =
  'not_found' | 'charge_voided' | 'exceeds_amount' | 'below_zero';

/** An invoiced amount that cannot be applied; the line is left as it was. */
export class ChargeLineAdjustmentError extends Error {
  constructor(readonly reason: ChargeLineAdjustmentReason) {
    super(`charge line adjustment refused: ${reason}`);
    this.name = 'ChargeLineAdjustmentError';
  }
}

/**
 * Adds `deltaCents` (negative for a credit note) to what has been invoiced of a line. The row is
 * locked first, so two invoices over one line cannot both pass the check; the amount stays between
 * zero and the amount of the line, and nothing else about the line changes (a trigger insists).
 * More cannot be invoiced of a voided charge. If the invoicing tables keep `invoiced_cents` with
 * a trigger of their own (migration 0444), the trigger is the one writer and this is not called.
 */
export async function adjustInvoicedCents(
  tx: Tx,
  lineId: string,
  deltaCents: number,
): Promise<ChargeLineForInvoicing> {
  const delta = money(deltaCents);
  const [view] = await lineQuery(tx)
    .where(and(eq(chargeLine.id, lineId)))
    .for('update', { of: chargeLine });
  if (!view) throw new ChargeLineAdjustmentError('not_found');
  if (delta > 0 && view.chargeStatus === 'voided')
    throw new ChargeLineAdjustmentError('charge_voided');

  const next = view.line.invoicedCents + delta;
  if (next < 0) throw new ChargeLineAdjustmentError('below_zero');
  if (next > view.line.amountCents) throw new ChargeLineAdjustmentError('exceeds_amount');

  await tx.update(chargeLine).set({ invoicedCents: next }).where(eq(chargeLine.id, lineId));
  return toLine({ ...view, line: { ...view.line, invoicedCents: next } });
}
