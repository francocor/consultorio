import { DownloadLinkResponse, ExportPackageResponse } from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

/** The two audiences of the cancellation export: the owner and a professional. */
export type ExportAudience = 'administrative' | 'clinical';

export const exportKeys = {
  all: ['export'] as const,
  package: (audience: ExportAudience) => ['export', audience] as const,
};

/** What the export screens ask of the API (the paths are the ones of the retention module). */
export function exportApi(api: ApiClient) {
  return {
    /** Where the package of this audience stands. */
    state: (audience: ExportAudience) =>
      api.get(`/cancellation/export/${audience}`, { schema: ExportPackageResponse }),
    /** Asks for a link and follows it with this session: the file arrives as a blob. */
    download: async (audience: ExportAudience) => {
      const link = await api.post(`/cancellation/export/${audience}/download`, {
        schema: DownloadLinkResponse,
      });
      return api.download(link.url);
    },
  };
}
