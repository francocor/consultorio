import type {
  AppliedCashFilters,
  CashReportFilters,
  CashReportResponse,
} from '@consultorio/contracts';

import type { Tx } from '../../../platform/db/tenant-context.js';
import { cashRegisters } from '../../billing/index.js';
import { buildCashDays } from '../domain/cash-days.js';

import type { ReportScope } from './scope.js';

/** The filters as the server applied them, for the screen and for an export to show. */
export function appliedCashFilters(
  scope: ReportScope,
  filters: CashReportFilters,
): AppliedCashFilters {
  return {
    from: filters.from,
    to: filters.to,
    locationId: filters.locationId ?? null,
    scope: scope.kind,
  };
}

/**
 * The cash register report (reports, "Cash register report"): per location and day, the opening
 * amount, the payments by method, the refunds, the expected cash, the counted cash and the
 * difference with its reason, from closed and open registers.
 *
 * The caller has already refused a scope that has no cash report (a professional); here the
 * organization reads every location and reception the ones it works at.
 */
export async function cashReport(
  tx: Tx,
  request: { scope: ReportScope; filters: CashReportFilters },
  deps: { clock: () => Date },
): Promise<CashReportResponse> {
  const { scope, filters } = request;
  // Never widen: a scope that has no cash report must not fall through to "every location".
  if (scope.kind === 'professional') throw new Error('a professional has no cash register report');
  const registers = await cashRegisters(tx, {
    fromDate: filters.from,
    toDate: filters.to,
    locationIds: scope.kind === 'locations' ? scope.locationIds : 'all',
    locationId: filters.locationId,
  });
  const { days, totals } = buildCashDays(registers);
  return {
    filters: appliedCashFilters(scope, filters),
    generatedAt: deps.clock().toISOString(),
    totals,
    days,
  };
}
