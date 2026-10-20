import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

import { s3Client, type BucketTarget } from '../backup/backup.js';
import { ensureBucket } from '../backup/bucket.js';
import { withTransientRetry } from '../backup/retry.js';

/**
 * The object store the drill keeps the backup in (the S3 API of MinIO, or of S3): the folder of a
 * backup goes up under a prefix, and the drill restores from what it reads back, so what is proven is
 * the copy that is kept and not the one still on the disk of whoever took it.
 */

async function* filesUnder(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}

/** Uploads every file of a backup folder under `prefix/` (created bucket if missing). Returns the keys. */
export async function uploadFolder(
  target: BucketTarget,
  dir: string,
  prefix: string,
): Promise<string[]> {
  const client = s3Client(target);
  try {
    await ensureBucket(client, target.bucket);
    const keys: string[] = [];
    for await (const path of filesUnder(dir)) {
      const key = `${prefix}/${relative(dir, path).split(sep).join('/')}`;
      const { size } = await stat(path);
      // The request and the stream are one unit: a reset connection reads the file again.
      await withTransientRetry(() =>
        client.send(
          new PutObjectCommand({
            Bucket: target.bucket,
            Key: key,
            Body: createReadStream(path),
            ContentLength: size,
          }),
        ),
      );
      keys.push(key);
    }
    return keys;
  } finally {
    client.destroy();
  }
}

/** Reads every object under `prefix/` into a folder. A key that would leave the folder is refused. */
export async function downloadFolder(
  target: BucketTarget,
  prefix: string,
  dest: string,
): Promise<number> {
  const client = s3Client(target);
  const root = resolve(dest);
  try {
    let files = 0;
    let token: string | undefined;
    do {
      const page = await withTransientRetry(() =>
        client.send(
          new ListObjectsV2Command({
            Bucket: target.bucket,
            Prefix: `${prefix}/`,
            ContinuationToken: token,
          }),
        ),
      );
      for (const item of page.Contents ?? []) {
        const key = item.Key;
        if (key === undefined) continue;
        const path = resolve(root, ...key.slice(prefix.length + 1).split('/'));
        if (!path.startsWith(root + sep)) throw new Error(`the key ${key} leaves the folder`);
        await mkdir(dirname(path), { recursive: true });
        await withTransientRetry(async () => {
          const object = await client.send(
            new GetObjectCommand({ Bucket: target.bucket, Key: key }),
          );
          const body = object.Body as NodeJS.ReadableStream | undefined;
          if (!body) throw new Error(`object ${key} has no body`);
          await pipeline(body, createWriteStream(path));
        });
        files += 1;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return files;
  } finally {
    client.destroy();
  }
}

/** Empties a bucket and deletes it (the scratch bucket of the drill). A bucket that is not there is fine. */
export async function removeBucket(target: BucketTarget): Promise<void> {
  const client = s3Client(target);
  try {
    let token: string | undefined;
    do {
      const page = await withTransientRetry(() =>
        client.send(new ListObjectsV2Command({ Bucket: target.bucket, ContinuationToken: token })),
      );
      for (const item of page.Contents ?? []) {
        if (item.Key === undefined) continue;
        const key = item.Key;
        await withTransientRetry(() =>
          client.send(new DeleteObjectCommand({ Bucket: target.bucket, Key: key })),
        );
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    await withTransientRetry(() => client.send(new DeleteBucketCommand({ Bucket: target.bucket })));
  } catch (error) {
    if ((error as { name?: string }).name !== 'NoSuchBucket') throw error;
  } finally {
    client.destroy();
  }
}
