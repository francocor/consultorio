import { createHash } from 'node:crypto';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectLockConfigurationCommand,
  PutObjectCommand,
  PutObjectRetentionCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLegalErasure } from '../../src/adapters/archive-local/erasure.js';
import { createLocalArchiveStore } from '../../src/adapters/archive-local/index.js';
import { startArchiveMinio, type ArchiveMinio } from '../support/archive-minio.js';

/**
 * The immutability of the retention archive against the real bucket (tenancy, "Retention archive after
 * cancellation": "Records in the archive MUST NOT be modified or hard-deleted during that period",
 * with a single exception, the legal erasure). Slow: it needs MinIO, the same image the development
 * environment runs, with the bucket created as `infra/docker-compose.yml` creates it.
 *
 * What is proven is what each identity CAN DO to an object that is inside its retention:
 * - the writer of the API, the worker and the releaser cannot delete it, cannot delete a version of it,
 *   cannot shorten its retention and cannot change the lock of the bucket;
 * - not even the root user of the service can delete it without saying that it bypasses governance;
 * - a writer that skips the `If-None-Match` of the adapter can add a version under the key, but the
 *   archive keeps serving the original, and the object says that something else is there;
 * - only the `legal-erasure` identity removes it, version by version, and it needs the reference.
 */
let minio: ArchiveMinio;
let writer: S3Client;
let erasure: S3Client;

const clientFor = (credentials: S3ClientConfig['credentials']) =>
  new S3Client({
    region: 'us-east-1',
    endpoint: minio.endpoint,
    forcePathStyle: true,
    credentials,
    maxAttempts: 1,
  });

beforeAll(async () => {
  minio = await startArchiveMinio();
  writer = clientFor(minio.writer);
  erasure = clientFor(minio.legalErasure);
}, 180_000);

afterAll(async () => {
  writer.destroy();
  erasure.destroy();
  await minio.stop();
});

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const inAYear = () => new Date(Date.now() + 365 * 24 * 3600 * 1000);

function adapter(credentials = minio.writer) {
  return createLocalArchiveStore({
    bucket: minio.bucket,
    region: minio.region,
    endpoint: minio.endpoint,
    credentials,
  });
}

async function archived(key: string, text: string) {
  const store = adapter();
  try {
    const result = await store.put(key, new TextEncoder().encode(text), {
      sha256: sha256(text),
      retainUntil: inAYear(),
    });
    expect(result.status).toBe('stored');
  } finally {
    store.close();
  }
}

/** The error name an attempt ends with, or "allowed". */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'allowed';
  } catch (error) {
    return (error as Error).name;
  }
}

async function versionsOf(client: S3Client, key: string) {
  const listed = await client.send(
    new ListObjectVersionsCommand({ Bucket: minio.bucket, Prefix: key }),
  );
  return (listed.Versions ?? []).filter((version) => version.Key === key);
}

describe('what the writer cannot do to an archived object', () => {
  it('cannot delete it, nor a version of it', async () => {
    const key = 'immutability/delete-by-writer';
    await archived(key, 'records of a cancelled organization');
    const [version] = await versionsOf(writer, key);

    const plain = await outcome(() =>
      writer.send(new DeleteObjectCommand({ Bucket: minio.bucket, Key: key })),
    );
    const byVersion = await outcome(() =>
      writer.send(
        new DeleteObjectCommand({ Bucket: minio.bucket, Key: key, VersionId: version?.VersionId }),
      ),
    );
    const bypassing = await outcome(() =>
      writer.send(
        new DeleteObjectCommand({
          Bucket: minio.bucket,
          Key: key,
          VersionId: version?.VersionId,
          BypassGovernanceRetention: true,
        }),
      ),
    );

    expect([plain, byVersion, bypassing]).toEqual(['AccessDenied', 'AccessDenied', 'AccessDenied']);
    expect(await versionsOf(writer, key)).toHaveLength(1);
  });

  it('cannot shorten the retention of the object or of the bucket', async () => {
    const objectName = 'immutability/shorten';
    await archived(objectName, 'kept');

    const object = await outcome(() =>
      writer.send(
        new PutObjectRetentionCommand({
          Bucket: minio.bucket,
          Key: objectName,
          Retention: { Mode: 'GOVERNANCE', RetainUntilDate: new Date(Date.now() + 1000) },
        }),
      ),
    );
    const bucket = await outcome(() =>
      writer.send(
        new PutObjectLockConfigurationCommand({
          Bucket: minio.bucket,
          ObjectLockConfiguration: {
            ObjectLockEnabled: 'Enabled',
            Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 1 } },
          },
        }),
      ),
    );

    expect(object).not.toBe('allowed');
    expect(bucket).toBe('AccessDenied');
    const store = adapter();
    const head = await store.head(objectName);
    store.close();
    expect(head.status === 'found' ? Date.parse(head.object.retainUntil) : 0).toBeGreaterThan(
      Date.now() + 300 * 24 * 3600 * 1000,
    );
  });

  it('cannot replace the object through the adapter: the same key with other bytes is refused by the service', async () => {
    const key = 'immutability/overwrite-by-adapter';
    await archived(key, 'original');
    const store = adapter();

    const other = await store.put(key, new TextEncoder().encode('forged'), {
      sha256: sha256('forged'),
      retainUntil: inAYear(),
    });
    const got = await store.get(key);
    store.close();

    expect(other.status).toBe('locked');
    expect(got.status === 'found' ? new TextDecoder().decode(got.body) : '').toBe('original');
    expect(await versionsOf(writer, key)).toHaveLength(1);
  });

  it('can add a version behind the adapter, but the archive keeps serving the original and says something else is there', async () => {
    const key = 'immutability/overwrite-behind-the-adapter';
    await archived(key, 'original');

    // What a leaked writer credential could do: PUT without the header the adapter sends.
    const put = await writer.send(
      new PutObjectCommand({
        Bucket: minio.bucket,
        Key: key,
        Body: Buffer.from('forged'),
        ObjectLockMode: 'GOVERNANCE',
        ObjectLockRetainUntilDate: inAYear(),
        Metadata: { sha256: sha256('forged') },
      }),
    );
    const store = adapter();
    const head = await store.head(key);
    const got = await store.get(key);
    const listed = await store.list('immutability/overwrite-behind-the-adapter');
    store.close();

    expect(put.VersionId).toBeDefined();
    expect(got.status === 'found' ? new TextDecoder().decode(got.body) : '').toBe('original');
    expect(head.status === 'found' ? head.object.sha256 : '').toBe(sha256('original'));
    expect(head.status === 'found' ? head.object.versions : 0).toBe(2);
    expect(listed.status === 'ok' ? listed.objects.map((entry) => entry.versions) : []).toEqual([
      2,
    ]);
    // The service still holds the original version, locked, byte for byte.
    const versions = await versionsOf(writer, key);
    const original = versions.at(-1);
    const read = await writer.send(
      new GetObjectCommand({ Bucket: minio.bucket, Key: key, VersionId: original?.VersionId }),
    );
    expect(await read.Body?.transformToString()).toBe('original');
  });
});

describe('what nobody can do inside the retention', () => {
  it('lets not even the root user delete a version without saying it bypasses governance', async () => {
    const key = 'immutability/root';
    await archived(key, 'kept');
    const root = clientFor(minio.root);
    try {
      const [version] = await versionsOf(root, key);

      const plain = await outcome(() =>
        root.send(
          new DeleteObjectCommand({
            Bucket: minio.bucket,
            Key: key,
            VersionId: version?.VersionId,
          }),
        ),
      );

      expect(plain).not.toBe('allowed');
      expect(await versionsOf(root, key)).toHaveLength(1);
    } finally {
      root.destroy();
    }
  });
});

describe('the legal erasure', () => {
  it('is refused to a credential that is not the legal-erasure one', async () => {
    const key = 'immutability/erase-by-writer';
    await archived(key, 'kept');
    const eraser = createLegalErasure({
      bucket: minio.bucket,
      region: minio.region,
      endpoint: minio.endpoint,
      credentials: minio.writer,
    });

    await expect(eraser.erase(key, { reference: 'Oficio 123/2031' })).rejects.toMatchObject({
      name: 'AccessDenied',
    });
    eraser.close();

    expect(await versionsOf(writer, key)).toHaveLength(1);
  });

  it('removes every version of the object for the privileged identity, and needs the reference', async () => {
    const key = 'immutability/erase-by-privileged';
    await archived(key, 'to be erased by order');
    await writer.send(
      new PutObjectCommand({
        Bucket: minio.bucket,
        Key: key,
        Body: Buffer.from('second version'),
        ObjectLockMode: 'GOVERNANCE',
        ObjectLockRetainUntilDate: inAYear(),
      }),
    );
    const eraser = createLegalErasure({
      bucket: minio.bucket,
      region: minio.region,
      endpoint: minio.endpoint,
      credentials: minio.legalErasure,
    });

    await expect(eraser.erase(key, { reference: '   ' })).rejects.toThrow(/legal reference/);
    expect(await versionsOf(erasure, key)).toHaveLength(2);

    const erased = await eraser.erase(key, { reference: 'Oficio 123/2031, Juzgado Civil 4' });
    const again = await eraser.erase(key, { reference: 'Oficio 123/2031, Juzgado Civil 4' });
    eraser.close();

    expect(erased).toEqual({ status: 'erased', versions: 2 });
    expect(again).toEqual({ status: 'unknown' });
    expect(await versionsOf(erasure, key)).toHaveLength(0);
    const store = adapter();
    expect(await store.head(key)).toEqual({ status: 'unknown' });
    store.close();
  });
});
