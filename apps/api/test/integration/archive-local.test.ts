import { afterAll, beforeAll } from 'vitest';

import { createLocalArchiveStore } from '../../src/adapters/archive-local/index.js';
import {
  describeArchiveStoreContract,
  SHORT_RETENTION_MS,
} from '../../src/adapters/archive-store.contract.js';
import { startArchiveMinio, type ArchiveMinio } from '../support/archive-minio.js';

/**
 * The local archive adapter against the real thing: the same MinIO image the development environment
 * runs, a bucket created with Object Lock in governance mode, and the `archive-writer` identity with
 * its bucket policy. It passes the same contract suite as the in-memory fake. The retention is real
 * time here, so crossing a short one waits for it.
 */
let minio: ArchiveMinio;

beforeAll(async () => {
  minio = await startArchiveMinio();
}, 180_000);

afterAll(async () => {
  await minio.stop();
});

describeArchiveStoreContract({
  name: 'local MinIO (Object Lock, governance mode)',
  make: () => {
    const store = createLocalArchiveStore({
      bucket: minio.bucket,
      region: minio.region,
      endpoint: minio.endpoint,
      credentials: minio.writer,
    });
    return Promise.resolve({
      store,
      retainFor: (ms) => new Date(Date.now() + ms),
      pastShortRetention: () =>
        new Promise<void>((resolve) => setTimeout(resolve, SHORT_RETENTION_MS + 1500)),
      close: () => {
        store.close();
        return Promise.resolve();
      },
    });
  },
});
