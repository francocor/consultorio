import {
  CashReportResponse,
  FinancialRecordsResponse,
  FinancialReportResponse,
  OperationalReportResponse,
  ReportOptionsResponse,
  ReportRecordsResponse,
  type FinancialRecordKind,
  type ReportGroup,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';
import type { Period } from '../domain/period.js';

/** What a report is cut by: the period and the narrowing filters the viewer chose. */
export interface ReportQuery extends Period {
  locationId?: string | undefined;
  professionalId?: string | undefined;
  specialty?: string | undefined;
  /** A payer of the organization; only the financial report reads it. */
  tenantPayerId?: string | undefined;
}

export const reportKeys = {
  all: ['reports'] as const,
  options: ['reports', 'options'] as const,
  operational: (query: ReportQuery) => ['reports', 'operational', query] as const,
  records: (query: ReportQuery, group: ReportGroup, offset: number) =>
    ['reports', 'records', query, group, offset] as const,
  financial: (query: ReportQuery) => ['reports', 'financial', query] as const,
  financialRecords: (query: ReportQuery, kind: FinancialRecordKind, offset: number) =>
    ['reports', 'financial-records', query, kind, offset] as const,
  cash: (query: ReportQuery) => ['reports', 'cash', query] as const,
};

/** The members the financial report reads: it has no specialty. */
function financialParams(query: ReportQuery) {
  return {
    from: query.from,
    to: query.to,
    locationId: query.locationId,
    professionalId: query.professionalId,
    tenantPayerId: query.tenantPayerId,
  };
}

/** What the report screens ask of the API. The scope of the viewer is applied by the server. */
export function reportsApi(api: ApiClient) {
  return {
    options: () => api.get('/reports/options', { schema: ReportOptionsResponse }),
    operational: (query: ReportQuery) =>
      api.get('/reports/operational', { query: { ...query }, schema: OperationalReportResponse }),
    records: (query: ReportQuery, group: ReportGroup, limit: number, offset: number) =>
      api.get('/reports/operational/records', {
        query: { ...query, group, limit, offset },
        schema: ReportRecordsResponse,
      }),
    financial: (query: ReportQuery) =>
      api.get('/reports/financial', {
        query: financialParams(query),
        schema: FinancialReportResponse,
      }),
    financialRecords: (
      query: ReportQuery,
      kind: FinancialRecordKind,
      limit: number,
      offset: number,
    ) =>
      api.get('/reports/financial/records', {
        query: { ...financialParams(query), kind, limit, offset },
        schema: FinancialRecordsResponse,
      }),
    cash: (query: ReportQuery) =>
      api.get('/reports/cash', {
        query: {
          from: query.from,
          to: query.to,
          locationId: query.locationId,
        },
        schema: CashReportResponse,
      }),
  };
}
