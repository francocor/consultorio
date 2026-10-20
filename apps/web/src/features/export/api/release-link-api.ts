import { ArchiveReleaseLinkResponse } from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

const enc = encodeURIComponent;

/**
 * The slug of the public prefix (`/public/:slug/archive-release/:token`). The API never reads it: the
 * organization is the host's, and the page of an emailed link cannot know the slug.
 */
const PREFIX = '/public/_/archive-release';

/** What the page of a release link asks of the API: when it ends, and the package once. */
export function releaseLinkApi(api: ApiClient) {
  return {
    /** Looks at the link without spending it (a mail scanner may have opened the address). */
    inspect: (token: string) =>
      api.get(`${PREFIX}/${enc(token)}`, { schema: ArchiveReleaseLinkResponse }),
    /** Spends the link and receives the package. */
    redeem: (token: string) => api.download(`${PREFIX}/${enc(token)}`, { method: 'POST' }),
  };
}
