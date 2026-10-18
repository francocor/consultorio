import {
  money,
  type AppliedFinancialFilters,
  type FinancialFilters,
  type FinancialRecordDto,
  type FinancialRecordsQuery,
  type FinancialRecordsResponse,
  type FinancialReportResponse,
} from '@consultorio/contracts';

import type { Tx } from '../../../platform/db/tenant-context.js';
import {
  chargeFacts,
  chargeRecords,
  paymentFacts,
  paymentRecords,
  reportNames,
  type MoneyCohort,
  type MoneyRecord,
  type MoneyRecordPage,
} from '../../billing/index.js';
import {
  readInvoicedLines,
  summarizeInvoiced,
  type InvoicedGroup,
  type InvoicedLine,
} from '../../invoicing/index.js';
import { inScope, mergeRows } from '../domain/financial-rows.js';

import { canSeeRevenueByProfessional, moneyScope, type ReportScope } from './scope.js';

/** The filters as the server applied them, for the screen and for an export to show. */
export function appliedFinancialFilters(
  scope: ReportScope,
  filters: FinancialFilters,
): AppliedFinancialFilters {
  return {
    from: filters.from,
    to: filters.to,
    locationId: filters.locationId ?? null,
    professionalId: filters.professionalId ?? null,
    tenantPayerId: filters.tenantPayerId ?? null,
    scope: scope.kind,
  };
}

/** The cohort billing is asked to read for a scope and the filters of a request. */
export function moneyCohortOf(scope: ReportScope, filters: FinancialFilters): MoneyCohort {
  return {
    fromDate: filters.from,
    toDate: filters.to,
    scope: moneyScope(scope),
    locationId: filters.locationId,
    professionalId: filters.professionalId,
    tenantPayerId: filters.tenantPayerId,
  };
}

// Invoices ---------------------------------------------------------------------------------------

/**
 * The lines of the issued and registered vouchers whose date falls in the period, cut like the
 * charges they cover: what the viewer may see, and the narrowing filters. A voucher is in the period
 * by the date printed on it. Invoices are read only through the index of invoicing.
 */
async function invoicedLines(
  tx: Tx,
  scope: ReportScope,
  filters: FinancialFilters,
): Promise<InvoicedLine[]> {
  const visible = moneyScope(scope);
  const rows = await readInvoicedLines(tx, { from: filters.from, to: filters.to });
  return rows.filter(
    (row) =>
      inScope(visible, row) &&
      (filters.locationId === undefined || row.locationId === filters.locationId) &&
      (filters.professionalId === undefined || row.professionalId === filters.professionalId) &&
      (filters.tenantPayerId === undefined || row.payerId === filters.tenantPayerId),
  );
}

const NO_INVOICES: InvoicedGroup = {
  key: 'all',
  invoicedCents: 0,
  creditedCents: 0,
  netCents: 0,
  documents: 0,
};

// The report -------------------------------------------------------------------------------------

export interface FinancialDeps {
  clock: () => Date;
}

/**
 * The financial report (reports, "Financial reports"). Every figure is derived from the records of
 * billing and invoicing and can be opened into them (`financialRecords`), for the same filters.
 *
 * - Charged: the lines of the charges that are not voided, by the day of the service. Voided
 *   charges are shown apart and are never part of it.
 * - Collected: payments minus refunds and corrections, by the day the money moved. Refunds are
 *   reductions, shown beside the payments.
 * - Outstanding: what the patient still owes on those charges. Receivable: the payer's part.
 * - Invoiced: issued and registered vouchers by their own date; credit notes reduce it. A rejected
 *   or pending attempt is not a voucher and never counts.
 * - Revenue by professional is for the organization and, for a professional, about themselves;
 *   reception gets none.
 */
export async function financialReport(
  tx: Tx,
  request: { scope: ReportScope; filters: FinancialFilters },
  deps: FinancialDeps,
): Promise<FinancialReportResponse> {
  const { scope, filters } = request;
  const cohort = moneyCohortOf(scope, filters);
  // One query at a time: all of them share the connection of the transaction.
  const charged = await chargeFacts(tx, cohort);
  const paid = await paymentFacts(tx, cohort);
  const vouchers = await invoicedLines(tx, scope, filters);
  const invoiced = (by: Parameters<typeof summarizeInvoiced>[1]) => summarizeInvoiced(vouchers, by);

  const invoicedTotal = invoiced('total')[0] ?? NO_INVOICES;
  return {
    filters: appliedFinancialFilters(scope, filters),
    generatedAt: deps.clock().toISOString(),
    totals: {
      charged: {
        count: charged.total.chargeCount,
        totalCents: money(charged.total.chargedCents),
        patientCents: money(charged.total.patientCents),
        payerCents: money(charged.total.payerCents),
      },
      voided: {
        count: charged.total.voidedCount,
        totalCents: money(charged.total.voidedCents),
      },
      collected: {
        paymentCount: paid.total.paymentCount,
        paymentsCents: money(paid.total.paymentsCents),
        refundCount: paid.total.refundCount,
        refundsCents: money(paid.total.refundsCents),
        netCents: money(paid.total.paymentsCents - paid.total.refundsCents),
      },
      outstanding: {
        chargeCount: charged.total.outstandingCount,
        cents: money(charged.total.outstandingCents),
      },
      receivable: { cents: money(charged.total.payerCents) },
      invoiced: {
        invoicedCents: money(invoicedTotal.invoicedCents),
        creditedCents: money(invoicedTotal.creditedCents),
        netCents: money(invoicedTotal.netCents),
        documents: invoicedTotal.documents,
      },
    },
    byMethod: paid.byMethod.map((fact) => ({
      method: fact.key as FinancialReportResponse['byMethod'][number]['method'],
      count: fact.paymentCount + fact.refundCount,
      paymentsCents: money(fact.paymentsCents),
      refundsCents: money(fact.refundsCents),
      netCents: money(fact.paymentsCents - fact.refundsCents),
    })),
    byPeriod: mergeRows(charged.byDay, paid.byDay, invoiced('day')),
    byLocation: mergeRows(charged.byLocation, paid.byLocation, invoiced('location')),
    byProfessional: canSeeRevenueByProfessional(scope)
      ? mergeRows(charged.byProfessional, paid.byProfessional, invoiced('professional'))
      : null,
    byPayer: mergeRows(charged.byPayer, paid.byPayer, invoiced('payer')),
    // A voucher does not say the appointment type: the net invoiced is not reported by it.
    byType: mergeRows(charged.byType, paid.byType, null),
  };
}

// The records behind a figure --------------------------------------------------------------------

function toRecordDto(record: MoneyRecord, scope: ReportScope): FinancialRecordDto {
  return {
    id: record.id,
    date: record.date,
    patientName: record.patientName,
    locationId: record.locationId,
    locationName: record.locationName,
    professionalId: record.professionalId,
    // Reception reads no revenue by professional, so a record does not name the professional either.
    professionalName: canSeeRevenueByProfessional(scope) ? record.professionalName : null,
    payerName: record.payerName,
    typeName: record.typeName,
    status: record.status,
    method: record.method,
    amountCents: money(record.amountCents),
    chargeTotalCents: record.chargeTotalCents === null ? null : money(record.chargeTotalCents),
  };
}

/** The voucher lines of the period as records: one per line, so the amounts add up to the figure. */
async function invoicedRecords(
  tx: Tx,
  scope: ReportScope,
  query: FinancialRecordsQuery,
): Promise<MoneyRecordPage> {
  const lines = await invoicedLines(tx, scope, query);
  const ordered = [...lines].sort(
    (a, b) =>
      a.issueDate.localeCompare(b.issueDate) ||
      a.invoiceId.localeCompare(b.invoiceId) ||
      a.chargeLineId.localeCompare(b.chargeLineId),
  );
  const page = ordered.slice(query.offset, query.offset + query.limit);

  const names = await reportNames(tx, {
    locations: [...new Set(page.map((line) => line.locationId))],
    professionals: [...new Set(page.map((line) => line.professionalId))],
    payers: [],
  });
  return {
    total: ordered.length,
    sumCents: ordered.reduce((sum, line) => sum + line.netCents, 0),
    records: page.map((line) => ({
      id: line.invoiceId,
      date: line.issueDate,
      // A voucher line names no patient.
      patientName: null,
      locationId: line.locationId,
      locationName: names.locations.get(line.locationId) ?? '',
      professionalId: line.professionalId,
      professionalName: names.professionals.get(line.professionalId) ?? null,
      payerName: line.payerName,
      typeName: null,
      status: line.type,
      method: null,
      amountCents: line.netCents,
      chargeTotalCents: null,
    })),
  };
}

export async function financialRecords(
  tx: Tx,
  request: { scope: ReportScope; query: FinancialRecordsQuery },
): Promise<FinancialRecordsResponse> {
  const { scope, query } = request;
  const cohort = moneyCohortOf(scope, query);
  const paging = { limit: query.limit, offset: query.offset };
  const page =
    query.kind === 'collected'
      ? await paymentRecords(tx, cohort, paging)
      : query.kind === 'invoiced'
        ? await invoicedRecords(tx, scope, query)
        : await chargeRecords(tx, cohort, { kind: query.kind, ...paging });
  return {
    filters: appliedFinancialFilters(scope, query),
    kind: query.kind,
    total: page.total,
    sumCents: money(page.sumCents),
    limit: query.limit,
    offset: query.offset,
    records: page.records.map((record) => toRecordDto(record, scope)),
  };
}
