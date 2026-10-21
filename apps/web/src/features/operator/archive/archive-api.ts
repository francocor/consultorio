import {
  ArchiveOverviewResponse,
  ArchiveReleaseListResponse,
  ArchiveReleaseRequestDto,
  type RecordArchiveReleaseRequest,
  type RejectArchiveReleaseRequest,
  type VerifyArchiveReleaseIdentityRequest,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export const archiveKeys = {
  all: ['operator', 'archive'] as const,
  archives: ['operator', 'archive', 'archives'] as const,
  requests: ['operator', 'archive', 'requests'] as const,
};

/** What the archive tab asks of the operator API: requests and counts, never a record. */
export function archiveApi(api: ApiClient) {
  return {
    archives: async () =>
      (await api.get('/operator/archives', { schema: ArchiveOverviewResponse })).archives,
    requests: async () =>
      (await api.get('/operator/archive-releases', { schema: ArchiveReleaseListResponse }))
        .requests,
    record: (body: RecordArchiveReleaseRequest) =>
      api.post('/operator/archive-releases', { body, schema: ArchiveReleaseRequestDto }),
    verifyIdentity: (id: string, body: VerifyArchiveReleaseIdentityRequest) =>
      api.post(`/operator/archive-releases/${id}/verify-identity`, {
        body,
        schema: ArchiveReleaseRequestDto,
      }),
    approve: (id: string) =>
      api.post(`/operator/archive-releases/${id}/approve`, { schema: ArchiveReleaseRequestDto }),
    reject: (id: string, body: RejectArchiveReleaseRequest) =>
      api.post(`/operator/archive-releases/${id}/reject`, {
        body,
        schema: ArchiveReleaseRequestDto,
      }),
  };
}
