import {
  OperationalReportResponse,
  ReportOptionsResponse,
  ReportRecordsResponse,
  type ReportGroup,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';
import type { Period } from '../domain/period.js';

/** What a report is cut by: the period and the narrowing filters the viewer chose. */
export interface ReportQuery extends Period {
  locationId?: string | undefined;
  professionalId?: string | undefined;
  specialty?: string | undefined;
}

export const reportKeys = {
  all: ['reports'] as const,
  options: ['reports', 'options'] as const,
  operational: (query: ReportQuery) => ['reports', 'operational', query] as const,
  records: (query: ReportQuery, group: ReportGroup, offset: number) =>
    ['reports', 'records', query, group, offset] as const,
};

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
  };
}
