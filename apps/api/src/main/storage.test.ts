import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { tenantKey } from '../platform/storage/object-storage.js';

import { createConfiguredStorage } from './storage.js';

const TENANT = '0190a000-0000-7000-8000-0000000000a1';

describe('the configured object storage', () => {
  const folders: string[] = [];
  afterAll(async () => {
    for (const folder of folders) await rm(folder, { recursive: true, force: true });
  });

  it('is nothing when neither a bucket nor a folder is configured', () => {
    expect(createConfiguredStorage({})).toBeUndefined();
  });

  it('is the filesystem when a folder is configured, with the receiver of its upload links', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'consulvia-configured-'));
    folders.push(dir);

    const storage = createConfiguredStorage({
      fsStorage: { dir, uploadSecret: 'placeholder-upload-secret-0123456789-abcdef' },
    });

    expect(storage?.uploads).toBeDefined();
    const key = tenantKey(TENANT, 'docs', 'a1');
    await storage?.put(TENANT, key, { body: Buffer.from('hola'), contentType: 'text/plain' });
    expect(await storage?.head(TENANT, key)).toEqual({ size: 4, contentType: 'text/plain' });
  });

  it('is S3 when a bucket is configured, which has no receiver: the bucket checks the policy itself', () => {
    const storage = createConfiguredStorage({
      storage: { bucket: 'files-bucket', region: 'sa-east-1', forcePathStyle: false },
    });

    expect(storage).toBeDefined();
    expect(storage?.uploads).toBeUndefined();
    storage?.close();
  });

  it('prefers nothing: a configuration with both is refused by the config, and here by the factory', () => {
    expect(() =>
      createConfiguredStorage({
        storage: { bucket: 'files-bucket', region: 'sa-east-1', forcePathStyle: false },
        fsStorage: { dir: tmpdir(), uploadSecret: 'placeholder-upload-secret-0123456789-abcdef' },
      }),
    ).toThrow(/one place/);
  });
});
