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
import { mergeRows } from '../domain/financial-rows.js';

import { invoicedFacts, voucherLinesPage } from './invoiced-facts.js';
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
  const vouchers = await invoicedFacts(tx, cohort);
  const invoicedTotal = vouchers.total;
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
    byPeriod: mergeRows(charged.byDay, paid.byDay, vouchers.byDay),
    byLocation: mergeRows(charged.byLocation, paid.byLocation, vouchers.byLocation),
    byProfessional: canSeeRevenueByProfessional(scope)
      ? mergeRows(charged.byProfessional, paid.byProfessional, vouchers.byProfessional)
      : null,
    byPayer: mergeRows(charged.byPayer, paid.byPayer, vouchers.byPayer),
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
  cohort: MoneyCohort,
  paging: { limit: number; offset: number },
): Promise<MoneyRecordPage> {
  const page = await voucherLinesPage(tx, cohort, paging);
  const names = await reportNames(tx, {
    locations: [...new Set(page.lines.map((line) => line.locationId))],
    professionals: [...new Set(page.lines.map((line) => line.professionalId))],
    payers: [],
  });
  return {
    total: page.total,
    sumCents: page.sumCents,
    records: page.lines.map((line) => ({
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
        ? await invoicedRecords(tx, cohort, paging)
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
