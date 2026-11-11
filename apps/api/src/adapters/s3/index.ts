import type { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

import {
  assertTenantKey,
  ObjectChangedError,
  type MoveOptions,
  type ObjectHead,
  type ObjectStorage,
  type PresignedPost,
  type PresignedPostInput,
  type PutObjectInput,
  type StoredObject,
} from '../../platform/storage/object-storage.js';

export interface S3StorageConfig {
  bucket: string;
  region: string;
  /** Set for MinIO (local) or any S3-compatible service. Unset for AWS S3. */
  endpoint?: string;
  /** MinIO needs path-style addressing (`host/bucket/key`). */
  forcePathStyle?: boolean;
  /** Static credentials for local MinIO. Production leaves them out: the task role is used. */
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

export interface S3ObjectStorage extends ObjectStorage {
  /** The client, so a caller can close its sockets at shutdown. */
  close(): void;
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof S3ServiceException)) return false;
  return (
    error.$metadata.httpStatusCode === 404 ||
    error.name === 'NoSuchKey' ||
    error.name === 'NotFound'
  );
}

function isPreconditionFailed(error: unknown): boolean {
  if (!(error instanceof S3ServiceException)) return false;
  return error.$metadata.httpStatusCode === 412 || error.name === 'PreconditionFailed';
}

/**
 * ObjectStorage on the S3 API (AWS S3 in production, MinIO locally). The tenant prefix is checked
 * before every call (`assertTenantKey`), so the bucket policy is a second wall, not the only one.
 *
 * Encryption at rest is the bucket's default (SSE-KMS in production); this adapter does not ask
 * for a per-object key, because MinIO's development setup has none.
 */
export function createS3ObjectStorage(config: S3StorageConfig): S3ObjectStorage {
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
    ...(config.credentials === undefined ? {} : { credentials: config.credentials }),
  });
  const Bucket = config.bucket;

  return {
    async put(tenantId: string, key: string, input: PutObjectInput): Promise<void> {
      assertTenantKey(tenantId, key);
      // A stream of unknown length is read into memory first: S3 needs the length up front.
      const body: Buffer | Readable =
        Buffer.isBuffer(input.body) || input.contentLength !== undefined
          ? input.body
          : await buffer(input.body);
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: body,
          ContentType: input.contentType,
          ...(input.contentLength === undefined
            ? Buffer.isBuffer(body)
              ? { ContentLength: body.length }
              : {}
            : { ContentLength: input.contentLength }),
        }),
      );
    },

    async get(tenantId: string, key: string): Promise<StoredObject | null> {
      assertTenantKey(tenantId, key);
      try {
        const response = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        if (!response.Body) return null;
        return {
          size: response.ContentLength ?? 0,
          contentType: response.ContentType ?? 'application/octet-stream',
          stream: response.Body as Readable,
          etag: response.ETag ?? '',
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async head(tenantId: string, key: string): Promise<ObjectHead | null> {
      assertTenantKey(tenantId, key);
      try {
        const response = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return {
          size: response.ContentLength ?? 0,
          contentType: response.ContentType ?? 'application/octet-stream',
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async presignedPost(
      tenantId: string,
      key: string,
      input: PresignedPostInput,
    ): Promise<PresignedPost> {
      assertTenantKey(tenantId, key);
      const post = await createPresignedPost(client, {
        Bucket,
        Key: key,
        Expires: input.expiresInSeconds,
        // The object must be exactly what this link was made for: one type, within the cap.
        Fields: { 'Content-Type': input.contentType },
        Conditions: [
          ['content-length-range', 1, input.maxBytes],
          ['eq', '$Content-Type', input.contentType],
        ],
      });
      return {
        url: post.url,
        fields: post.fields,
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
      };
    },

    async move(
      tenantId: string,
      fromKey: string,
      toKey: string,
      options: MoveOptions = {},
    ): Promise<boolean> {
      assertTenantKey(tenantId, fromKey);
      assertTenantKey(tenantId, toKey);
      try {
        await client.send(
          new CopyObjectCommand({
            Bucket,
            Key: toKey,
            CopySource: `${Bucket}/${fromKey.split('/').map(encodeURIComponent).join('/')}`,
            MetadataDirective: 'COPY',
            // Copy only the object that was inspected: S3 refuses with 412 if it changed.
            ...(options.ifMatch === undefined ? {} : { CopySourceIfMatch: options.ifMatch }),
          }),
        );
      } catch (error) {
        if (isNotFound(error)) return false;
        if (isPreconditionFailed(error)) throw new ObjectChangedError();
        throw error;
      }
      await client.send(new DeleteObjectCommand({ Bucket, Key: fromKey }));
      return true;
    },

    async remove(tenantId: string, key: string): Promise<void> {
      assertTenantKey(tenantId, key);
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },

    close() {
      client.destroy();
    },
  };
}
