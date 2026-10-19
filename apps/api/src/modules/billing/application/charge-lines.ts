import {
  CHARGE_LINE_KINDS,
  CHARGE_LINE_PORTIONS,
  CHARGE_STATUSES,
  money,
  type ChargeLineKind,
  type ChargeLinePortion,
  type ChargeStatus,
} from '@consultorio/contracts';
import { asc, eq, inArray } from 'drizzle-orm';

import { charge, chargeLine } from '../../../db/schema/billing-charges.js';
import { tenantPayer } from '../../../db/schema/billing-pricing.js';
import { payer as payerCatalog } from '../../../db/schema/platform-catalogs.js';
import { appointment } from '../../../db/schema/scheduling.js';
import { location } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { summarizeCharge } from '../domain/charge-status.js';

import { localDay } from './common.js';

/**
 * The charge lines as the invoicing module (track C) uses them. Invoices cover lines of one or
 * several charges, and a line can be invoiced in parts (e-invoicing-afip); billing owns the lines
 * and exposes them here, through its index, so invoicing never reads the tables.
 *
 * Billing only READS `invoiced_cents`. The trigger of the invoices (migration 0444) is the one
 * writer of that column, and nothing in billing sets it.
 */

/** The payer a charge was made for: who an invoice of its payer lines is addressed to. */
export interface ChargePayer {
  /** The payer in the organization's list (`tenant_payer`). */
  id: string;
  name: string;
  /** The 11 digits of the CUIT, or null when the organization has not entered it yet. */
  cuit: string | null;
}

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
  payer: ChargePayer | null;
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
  catalogPayerName: payerCatalog.name,
  customPayerName: tenantPayer.customName,
  payerCuit: tenantPayer.cuit,
};

function lineQuery(tx: Tx) {
  return tx
    .select(lineColumns)
    .from(chargeLine)
    .innerJoin(charge, eq(charge.id, chargeLine.chargeId))
    .leftJoin(tenantPayer, eq(tenantPayer.id, charge.tenantPayerId))
    .leftJoin(payerCatalog, eq(payerCatalog.id, tenantPayer.payerId));
}

type LineView = Awaited<ReturnType<typeof lineQuery>>[number];

function payerOf(view: {
  tenantPayerId: string | null;
  catalogPayerName: string | null;
  customPayerName: string | null;
  payerCuit: string | null;
}): ChargePayer | null {
  if (view.tenantPayerId === null) return null;
  return {
    id: view.tenantPayerId,
    name: view.catalogPayerName ?? view.customPayerName ?? '',
    cuit: view.payerCuit,
  };
}

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
    payer: payerOf(view),
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
 * until the end of the transaction of the caller: the invoice is built over what it read.
 *
 * With `lockCharges: true` the charges the lines belong to are locked FOR SHARE first, in the order
 * of their ids, and the lines after them: charge, then lines, the order the void of a charge follows
 * (JD-S4 R1-C2). A void in progress makes the invoice wait and then read the charge as voided; an
 * invoice in progress makes the void wait and then see the invoice. Only a writer that creates an
 * invoice needs it: the rest of the writers of lines never read the state of the charge.
 */
export async function readChargeLines(
  tx: Tx,
  lineIds: readonly string[],
  options: { lock?: boolean; lockCharges?: boolean } = {},
): Promise<ChargeLineForInvoicing[]> {
  if (lineIds.length === 0) return [];
  if (options.lockCharges) {
    const owners = await tx
      .selectDistinct({ chargeId: chargeLine.chargeId })
      .from(chargeLine)
      .where(inArray(chargeLine.id, [...lineIds]))
      .orderBy(asc(chargeLine.chargeId));
    if (owners.length > 0) {
      await tx
        .select({ id: charge.id })
        .from(charge)
        .where(
          inArray(
            charge.id,
            owners.map((owner) => owner.chargeId),
          ),
        )
        .orderBy(asc(charge.id))
        .for('share');
    }
  }
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
  options: { lock?: boolean } = {},
): Promise<ChargeLineForInvoicing[]> {
  if (chargeIds.length === 0) return [];
  const base = lineQuery(tx)
    .where(inArray(chargeLine.chargeId, [...chargeIds]))
    .orderBy(asc(chargeLine.chargeId), asc(chargeLine.position));
  const views = await (options.lock ? base.for('update', { of: chargeLine }) : base);
  return views.map(toLine);
}

export interface ChargeForInvoicing {
  id: string;
  status: ChargeStatus;
  patientId: string;
  appointmentId: string;
  locationId: string;
  professionalId: string;
  payer: ChargePayer | null;
  /** The name of the appointment type, for screens. An invoice never prints it (JD-S4 R1-C9). */
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
      catalogPayerName: payerCatalog.name,
      customPayerName: tenantPayer.customName,
      payerCuit: tenantPayer.cuit,
    })
    .from(charge)
    .innerJoin(appointment, eq(appointment.id, charge.appointmentId))
    .innerJoin(location, eq(location.id, charge.locationId))
    .leftJoin(tenantPayer, eq(tenantPayer.id, charge.tenantPayerId))
    .leftJoin(payerCatalog, eq(payerCatalog.id, tenantPayer.payerId))
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

  return rows.map((entry) => {
    const { row } = entry;
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
      payer: payerOf({ tenantPayerId: row.tenantPayerId, ...entry }),
      appointmentTypeName:
        typeof snapshot.appointmentTypeName === 'string' ? snapshot.appointmentTypeName : '',
      serviceDate: localDay(entry.startsAt, entry.timeZone),
      totalCents: summary.totalCents,
      patientCents: summary.patientCents,
      payerCents: summary.payerCents,
      invoicedCents: summary.invoicedCents,
    };
  });
}
