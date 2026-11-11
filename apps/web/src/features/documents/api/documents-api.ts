import {
  CreateUploadsResponse,
  DocumentDto,
  DocumentListResponse,
  DocumentVersionsResponse,
  DownloadLinkResponse,
  type CreateUploadsRequest,
  type DocumentCategory,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export const documentKeys = {
  all: ['documents'] as const,
  list: (patientId: string, includeHidden: boolean) =>
    ['documents', 'list', patientId, { includeHidden }] as const,
  patient: (patientId: string) => ['documents', 'list', patientId] as const,
  versions: (documentId: string) => ['documents', 'versions', documentId] as const,
};

/** The documents module of the API. Every call is the organization of the signed-in session. */
export function documentsApi(api: ApiClient) {
  return {
    list: (patientId: string, includeHidden: boolean) =>
      api.get(`/patients/${patientId}/documents`, {
        query: { includeHidden: includeHidden ? 'true' : undefined },
        schema: DocumentListResponse,
      }),
    versions: (documentId: string) =>
      api.get(`/documents/${documentId}/versions`, { schema: DocumentVersionsResponse }),
    /** Registers the files; the answer has one presigned POST per file. */
    createUploads: (body: CreateUploadsRequest) =>
      api.post('/documents/uploads', { body, schema: CreateUploadsResponse }),
    /** Tells the server the file reached storage, which starts the scan. */
    confirmUpload: (documentId: string) =>
      api.post(`/documents/${documentId}/uploaded`, { schema: DocumentDto }),
    hide: (documentId: string, reason: string) =>
      api.post(`/documents/${documentId}/hide`, { body: { reason }, schema: DocumentDto }),
    reclassify: (documentId: string, category: DocumentCategory) =>
      api.post(`/documents/${documentId}/reclassify`, { body: { category }, schema: DocumentDto }),
    /** Asks for a link and follows it with this session: the file arrives as a blob. */
    download: async (documentId: string) => {
      const link = await api.post(`/documents/${documentId}/download-link`, {
        schema: DownloadLinkResponse,
      });
      return api.download(link.url);
    },
  };
}
