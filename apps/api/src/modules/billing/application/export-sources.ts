import { PAYMENT_METHODS, type ExportKind, type PaymentMethod } from '@consultorio/contracts';
import { and, asc, eq, gte, lte, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { charge, chargeLine } from '../../../db/schema/billing-charges.js';
import { payment, paymentReversal } from '../../../db/schema/billing-payments.js';
import { tenantPayer } from '../../../db/schema/billing-pricing.js';
import { patient } from '../../../db/schema/patients.js';
import { payer } from '../../../db/schema/platform-catalogs.js';
import { appointment } from '../../../db/schema/scheduling.js';
import { location } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { ExportSource } from '../../../platform/exports/export-job.js';
import { dayAsText } from '../../../platform/exports/format.js';
import type { ExportColumn, ExportRow, ExportTable } from '../../../platform/exports/types.js';
import {
  EXPORT_FILE_BASES,
  EXPORT_TITLES,
  METHOD_LABELS,
  MOVEMENT_LABELS,
  PRIVATE_LABEL,
  STATUS_LABELS,
} from '../domain/export-labels.js';

import { loadCharges, scopeCondition, serviceDay } from './charge-view.js';
import type { BillingScope } from './scope.js';

/**
 * What the exports list (billing-payments, "Exports"). Three sources: the charges, the payments and
 * refunds, and the payer settlement (the payer portions grouped by payer, with the DNI of the
 * patient, so the organization can bill the payer outside the system). Every column is chosen here
 * by name; nothing is read from a table that holds clinical content, so no note, diagnosis or
 * prescription can reach a file. The scope of the person who asked is part of the stored filters and
 * is applied again here, so a professional's file only ever lists their own appointments.
 */

const ScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all') }),
  z.strictObject({
    kind: z.literal('limited'),
    locationIds: z.array(z.uuid()),
    professionalId: z.uuid().nullable(),
  }),
]);

export const ExportFilters = z.strictObject({
  from: z.iso.date(),
  to: z.iso.date(),
  locationId: z.uuid().optional(),
  professionalId: z.uuid().optional(),
  tenantPayerId: z.uuid().optional(),
  scope: ScopeSchema,
});
export type ExportFilters = z.infer<typeof ExportFilters>;

const MAX_ROWS = 20_000;

/** What a scope looks like once stored with the request. */
export function storedScope(scope: BillingScope): ExportFilters['scope'] {
  return scope.kind === 'all'
    ? { kind: 'all' }
    : {
        kind: 'limited',
        locationIds: [...scope.locationIds],
        professionalId: scope.professionalId,
      };
}

function chargeScope(filters: ExportFilters): SQL | undefined {
  return scopeCondition(
    filters.scope.kind === 'all'
      ? { kind: 'all' }
      : {
          kind: 'limited',
          locationIds: filters.scope.locationIds,
          professionalId: filters.scope.professionalId,
        },
  );
}

async function filterLabels(tx: Tx, filters: ExportFilters) {
  const labels: { label: string; value: string }[] = [
    { label: 'Período', value: `${dayAsText(filters.from)} al ${dayAsText(filters.to)}` },
  ];
  if (filters.locationId) {
    const [place] = await tx
      .select({ name: location.name })
      .from(location)
      .where(eq(location.id, filters.locationId));
    labels.push({ label: 'Sede', value: place?.name ?? '' });
  }
  if (filters.tenantPayerId) {
    const [row] = await tx
      .select({ name: payer.name, custom: tenantPayer.customName })
      .from(tenantPayer)
      .leftJoin(payer, eq(payer.id, tenantPayer.payerId))
      .where(eq(tenantPayer.id, filters.tenantPayerId));
    labels.push({ label: 'Obra social o prepaga', value: row?.name ?? row?.custom ?? '' });
  }
  return labels;
}

const money = (key: string, label: string, width = 3): ExportColumn => ({
  key,
  label,
  type: 'money',
  width,
});
const text = (key: string, label: string, width = 3, pdf = true): ExportColumn => ({
  key,
  label,
  type: 'text',
  width,
  pdf,
});

function sum(rows: readonly ExportRow[], key: string): number {
  return rows.reduce((total, row) => {
    const cell = row.cells[key];
    return total + (typeof cell === 'number' ? cell : 0);
  }, 0);
}

// Charges ---------------------------------------------------------------------------------------

const CHARGE_COLUMNS: readonly ExportColumn[] = [
  { key: 'date', label: 'Fecha', type: 'date', width: 2 },
  text('patient', 'Paciente', 4),
  text('location', 'Sede', 3, false),
  text('professional', 'Profesional', 3, false),
  text('service', 'Servicio', 3),
  text('payer', 'Obra social o prepaga', 3, false),
  text('plan', 'Plan', 2, false),
  text('status', 'Estado', 2),
  money('total', 'Total', 3),
  money('patientPart', 'Paciente debe', 3),
  money('payerPart', 'Obra social debe', 3),
  money('paid', 'Cobrado', 3),
  money('outstanding', 'Falta cobrar', 3),
];

async function chargesTable(tx: Tx, filters: ExportFilters): Promise<ExportTable> {
  const charges = await loadCharges(
    tx,
    [
      chargeScope(filters),
      filters.locationId ? eq(charge.locationId, filters.locationId) : undefined,
      filters.professionalId ? eq(charge.professionalId, filters.professionalId) : undefined,
      filters.tenantPayerId ? eq(charge.tenantPayerId, filters.tenantPayerId) : undefined,
      gte(serviceDay, filters.from),
      lte(serviceDay, filters.to),
    ],
    { limit: MAX_ROWS },
  );
  const rows: ExportRow[] = charges.reverse().map((entry) => ({
    cells: {
      date: entry.snapshot.serviceDate,
      patient: entry.patientName,
      location: entry.locationName,
      professional: entry.professionalName,
      service: entry.appointmentTypeName,
      payer: entry.payerName ?? PRIVATE_LABEL,
      plan: entry.planName,
      status: STATUS_LABELS[entry.status],
      total: entry.totalCents,
      patientPart: entry.patientCents,
      payerPart: entry.payerCents,
      paid: entry.paidCents,
      outstanding: entry.status === 'voided' ? 0 : entry.outstandingCents,
    },
  }));
  const live = rows.filter((row) => row.cells['status'] !== STATUS_LABELS.voided);
  if (rows.length > 0) {
    rows.push({
      emphasis: 'total',
      cells: {
        patient: 'Total (sin cobros anulados)',
        total: sum(live, 'total'),
        patientPart: sum(live, 'patientPart'),
        payerPart: sum(live, 'payerPart'),
        paid: sum(live, 'paid'),
        outstanding: sum(live, 'outstanding'),
      },
    });
  }
  return {
    title: EXPORT_TITLES.charges,
    filters: await filterLabels(tx, filters),
    columns: CHARGE_COLUMNS,
    rows,
  };
}

// Payments --------------------------------------------------------------------------------------

const PAYMENT_COLUMNS: readonly ExportColumn[] = [
  { key: 'date', label: 'Fecha', type: 'date', width: 2 },
  text('patient', 'Paciente', 4),
  text('location', 'Sede', 3, false),
  text('service', 'Servicio', 3),
  text('payer', 'Obra social o prepaga', 3, false),
  text('movement', 'Movimiento', 3),
  text('method', 'Medio', 3),
  text('reference', 'Referencia', 3, false),
  money('amount', 'Importe', 3),
];

function isMethod(value: string): value is PaymentMethod {
  return PAYMENT_METHODS.some((method) => method === value);
}

async function paymentsTable(tx: Tx, filters: ExportFilters): Promise<ExportTable> {
  const where = (day: SQL) =>
    and(
      chargeScope(filters),
      filters.locationId ? eq(charge.locationId, filters.locationId) : undefined,
      filters.professionalId ? eq(charge.professionalId, filters.professionalId) : undefined,
      filters.tenantPayerId ? eq(charge.tenantPayerId, filters.tenantPayerId) : undefined,
      gte(day, filters.from),
      lte(day, filters.to),
    );
  const paidDay = sql<string>`(${payment.paidAt} at time zone ${location.timeZone})::date`;
  const reversedDay = sql<string>`(${paymentReversal.reversedAt} at time zone ${location.timeZone})::date`;

  const common = {
    givenNames: patient.givenNames,
    familyName: patient.familyName,
    locationName: location.name,
    snapshot: charge.snapshot,
    catalogPayer: payer.name,
    customPayer: tenantPayer.customName,
    tenantPayerId: charge.tenantPayerId,
  };

  const [paid, reversed] = await Promise.all([
    tx
      .select({
        ...common,
        at: payment.paidAt,
        method: payment.method,
        reference: payment.externalRef,
        amountCents: payment.amountCents,
      })
      .from(payment)
      .innerJoin(charge, eq(charge.id, payment.chargeId))
      .innerJoin(patient, eq(patient.id, charge.patientId))
      .innerJoin(location, eq(location.id, charge.locationId))
      .leftJoin(tenantPayer, eq(tenantPayer.id, charge.tenantPayerId))
      .leftJoin(payer, eq(payer.id, tenantPayer.payerId))
      .where(where(paidDay))
      .orderBy(asc(payment.paidAt), asc(payment.id))
      .limit(MAX_ROWS),
    tx
      .select({
        ...common,
        at: paymentReversal.reversedAt,
        kind: paymentReversal.kind,
        method: payment.method,
        reference: payment.externalRef,
        amountCents: paymentReversal.amountCents,
      })
      .from(paymentReversal)
      .innerJoin(payment, eq(payment.id, paymentReversal.paymentId))
      .innerJoin(charge, eq(charge.id, paymentReversal.chargeId))
      .innerJoin(patient, eq(patient.id, charge.patientId))
      .innerJoin(location, eq(location.id, charge.locationId))
      .leftJoin(tenantPayer, eq(tenantPayer.id, charge.tenantPayerId))
      .leftJoin(payer, eq(payer.id, tenantPayer.payerId))
      .where(where(reversedDay))
      .orderBy(asc(paymentReversal.reversedAt), asc(paymentReversal.id))
      .limit(MAX_ROWS),
  ]);

  const typeName = (snapshot: unknown) => {
    const value = (snapshot as { appointmentTypeName?: unknown } | null)?.appointmentTypeName;
    return typeof value === 'string' ? value : '';
  };
  const entries = [
    ...paid.map((row) => ({ row, movement: MOVEMENT_LABELS.payment, sign: 1 })),
    ...reversed.map((row) => ({
      row,
      movement: row.kind === 'correction' ? MOVEMENT_LABELS.correction : MOVEMENT_LABELS.refund,
      sign: -1,
    })),
  ].sort((a, b) => a.row.at.getTime() - b.row.at.getTime());

  const rows: ExportRow[] = entries.map(({ row, movement, sign }) => ({
    cells: {
      date: row.at.toISOString().slice(0, 10),
      patient: `${row.givenNames} ${row.familyName}`.trim(),
      location: row.locationName,
      service: typeName(row.snapshot),
      payer: row.tenantPayerId === null ? PRIVATE_LABEL : (row.catalogPayer ?? row.customPayer),
      movement,
      method: isMethod(row.method) ? METHOD_LABELS[row.method] : row.method,
      reference: row.reference,
      amount: sign * row.amountCents,
    },
  }));
  if (rows.length > 0) {
    rows.push({
      emphasis: 'total',
      cells: { patient: 'Total neto (pagos menos devoluciones)', amount: sum(rows, 'amount') },
    });
  }
  return {
    title: EXPORT_TITLES.payments,
    filters: await filterLabels(tx, filters),
    columns: PAYMENT_COLUMNS,
    rows,
  };
}

// Payer settlement ------------------------------------------------------------------------------

const SETTLEMENT_COLUMNS: readonly ExportColumn[] = [
  text('payer', 'Obra social o prepaga', 4),
  text('plan', 'Plan', 2, false),
  text('document', 'Documento', 3),
  text('patient', 'Paciente', 4),
  { key: 'date', label: 'Fecha', type: 'date', width: 2 },
  text('service', 'Servicio', 4),
  money('amount', 'Importe', 3),
];

const DOCUMENT_TYPES: Readonly<Record<string, string>> = {
  dni: 'DNI',
  passport: 'Pasaporte',
  cuit: 'CUIT',
};

async function settlementTable(tx: Tx, filters: ExportFilters): Promise<ExportTable> {
  const found = await tx
    .select({
      tenantPayerId: charge.tenantPayerId,
      planName: charge.planName,
      catalogPayer: payer.name,
      customPayer: tenantPayer.customName,
      documentType: patient.nationalIdType,
      document: patient.nationalId,
      givenNames: patient.givenNames,
      familyName: patient.familyName,
      snapshot: charge.snapshot,
      amountCents: chargeLine.amountCents,
    })
    .from(chargeLine)
    .innerJoin(charge, eq(charge.id, chargeLine.chargeId))
    .innerJoin(appointment, eq(appointment.id, charge.appointmentId))
    .innerJoin(location, eq(location.id, charge.locationId))
    .innerJoin(patient, eq(patient.id, charge.patientId))
    .innerJoin(tenantPayer, eq(tenantPayer.id, charge.tenantPayerId))
    .leftJoin(payer, eq(payer.id, tenantPayer.payerId))
    .where(
      and(
        eq(chargeLine.portion, 'payer'),
        ne(charge.status, 'voided'),
        chargeScope(filters),
        filters.locationId ? eq(charge.locationId, filters.locationId) : undefined,
        filters.professionalId ? eq(charge.professionalId, filters.professionalId) : undefined,
        filters.tenantPayerId ? eq(charge.tenantPayerId, filters.tenantPayerId) : undefined,
        gte(serviceDay, filters.from),
        lte(serviceDay, filters.to),
      ),
    )
    .orderBy(
      asc(sql`lower(coalesce(${payer.name}, ${tenantPayer.customName}))`),
      asc(appointment.startsAt),
      asc(charge.id),
      asc(chargeLine.position),
    )
    .limit(MAX_ROWS);

  const rows: ExportRow[] = [];
  let group: ExportRow[] = [];
  let currentPayer: string | null = null;
  const closeGroup = () => {
    if (group.length === 0 || currentPayer === null) return;
    rows.push(...group);
    rows.push({
      emphasis: 'subtotal',
      cells: { payer: `Subtotal ${currentPayer}`, amount: sum(group, 'amount') },
    });
    group = [];
  };
  for (const row of found) {
    const name = row.catalogPayer ?? row.customPayer ?? '';
    if (currentPayer !== null && name !== currentPayer) closeGroup();
    currentPayer = name;
    const snapshot = row.snapshot as { appointmentTypeName?: unknown; serviceDate?: unknown };
    group.push({
      cells: {
        payer: name,
        plan: row.planName,
        document:
          row.document === null
            ? null
            : `${DOCUMENT_TYPES[row.documentType ?? ''] ?? row.documentType ?? ''} ${row.document}`.trim(),
        patient: `${row.givenNames} ${row.familyName}`.trim(),
        date: typeof snapshot.serviceDate === 'string' ? snapshot.serviceDate : null,
        service:
          typeof snapshot.appointmentTypeName === 'string' ? snapshot.appointmentTypeName : '',
        amount: row.amountCents,
      },
    });
  }
  closeGroup();
  if (rows.length > 0) {
    rows.push({
      emphasis: 'total',
      cells: {
        payer: 'Total a liquidar',
        amount: sum(
          rows.filter((row) => row.emphasis === undefined),
          'amount',
        ),
      },
    });
  }
  return {
    title: EXPORT_TITLES.payer_settlement,
    filters: await filterLabels(tx, filters),
    columns: SETTLEMENT_COLUMNS,
    rows,
  };
}

/** The sources of the export job for billing, one per kind of export. */
export const BILLING_EXPORT_SOURCES: readonly (ExportSource & { kind: ExportKind })[] = [
  {
    kind: 'charges',
    fileBase: EXPORT_FILE_BASES.charges,
    build: (tx, filters) => chargesTable(tx, ExportFilters.parse(filters)),
  },
  {
    kind: 'payments',
    fileBase: EXPORT_FILE_BASES.payments,
    build: (tx, filters) => paymentsTable(tx, ExportFilters.parse(filters)),
  },
  {
    kind: 'payer_settlement',
    fileBase: EXPORT_FILE_BASES.payer_settlement,
    build: (tx, filters) => settlementTable(tx, ExportFilters.parse(filters)),
  },
];
