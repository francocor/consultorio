import { createFsObjectStorage } from '../adapters/fs-storage/index.js';
import { createS3ObjectStorage } from '../adapters/s3/index.js';
import type { ObjectStorage } from '../platform/storage/object-storage.js';
import type { UploadReceiver } from '../platform/storage/upload-receiver.js';

import type { Config } from './config.js';

export interface ConfiguredStorage extends ObjectStorage {
  /** Closes what the adapter holds open (the sockets of the S3 client). */
  close(): void;
  /**
   * Set when the storage has no server of its own to take the browser's POST (the disk): the
   * application mounts the route that calls it. S3 and MinIO check the signed policy themselves.
   */
  uploads?: UploadReceiver;
}

/**
 * Composition root for object storage: a folder on the disk when the deployment configures one (the
 * desktop profile), a bucket when it configures that (S3, MinIO), nothing otherwise, in which case the
 * features that keep files are unavailable. The one place that chooses; every process asks here.
 */
export function createConfiguredStorage(
  config: Pick<Config, 'storage' | 'fsStorage'>,
): ConfiguredStorage | undefined {
  if (config.storage && config.fsStorage) {
    // The config refuses it at boot; a caller that skips the config still cannot split the files.
    throw new Error('files live in one place: a bucket or a folder, not both');
  }
  if (config.fsStorage) return createFsObjectStorage(config.fsStorage);
  if (config.storage) return createS3ObjectStorage(config.storage);
  return undefined;
}
