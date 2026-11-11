import type { FileResource } from '../../../platform/files/file-resources.js';
import { FileRefused } from '../../../platform/files/file-resources.js';
import { AccessRefused } from '../../access/index.js';
import { contentDisposition } from '../domain/file-name.js';

import type { DownloadService } from './downloads.js';
import { DocumentRefused } from './refusal.js';

/** The reason the download service gives for a link that is not a live document link. */
const NOT_A_LIVE_LINK = 'document_link_invalid';

/** The type a file is served with. Text says its encoding so a browser never guesses. */
function servedType(contentType: string | null): string {
  if (contentType === null) return 'application/octet-stream';
  return contentType === 'text/plain' ? 'text/plain; charset=utf-8' : contentType;
}

/**
 * The documents module's part of `GET /files/:token`: the links of `document_download`. The
 * download service keeps deciding everything (the session binding, the five minutes, the access
 * rules, the audit entry); this only adapts its answer to the shared door.
 */
export function createDocumentFileResource(downloads: DownloadService): FileResource {
  return {
    kind: 'document_download',
    audits: ['document.downloaded'],
    async redeem(tx, input) {
      try {
        const row = await downloads.redeem(tx, input);
        return {
          objectKey: row.objectKey,
          contentType: servedType(row.contentType),
          contentDisposition: contentDisposition(row.originalName),
        };
      } catch (error) {
        // Not a link of this kind: the door asks the other resources before it refuses.
        if (error instanceof DocumentRefused && error.reason === NOT_A_LIVE_LINK) return null;
        if (error instanceof AccessRefused) {
          throw new FileRefused(
            error.reason,
            'document',
            error instanceof DocumentRefused ? error.context : {},
          );
        }
        throw error;
      }
    },
  };
}
