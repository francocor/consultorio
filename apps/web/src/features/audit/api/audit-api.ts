import { AuditListResponse, type AuditExportQuery } from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

/** The filters of the viewer, as the API takes them. */
export interface AuditFilters {
  action?: string | undefined;
  outcome?: string | undefined;
  patientId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

export const auditKeys = {
  all: ['audit'] as const,
  list: (filters: AuditFilters) => ['audit', 'list', filters] as const,
  accessReport: (patientId: string) => ['audit', 'access-report', patientId] as const,
};

/** The audit module of the API: the viewer, the access report of a patient and the export. */
export function auditApi(api: ApiClient) {
  return {
    list: (filters: AuditFilters, cursor?: string) =>
      api.get('/audit-events', {
        query: { ...filters, cursor },
        schema: AuditListResponse,
      }),
    accessReport: (patientId: string, cursor?: string) =>
      api.get(`/patients/${patientId}/access-report`, {
        query: { cursor },
        schema: AuditListResponse,
      }),
    export: (format: AuditExportQuery['format'], filters: AuditFilters) =>
      api.download('/audit-events/export', { query: { ...filters, format } }),
  };
}
