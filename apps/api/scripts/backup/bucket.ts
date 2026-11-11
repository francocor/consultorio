import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

import { withTransientRetry, type RetryOptions } from './retry.js';

/** The part of an S3 client the restore needs, so a test can script the store. */
export interface BucketClient {
  send(command: HeadBucketCommand | CreateBucketCommand): Promise<unknown>;
}

/**
 * Makes sure the bucket of the restore exists. A create that is asked again after the connection was
 * reset may find the bucket the first call already made: the store answers `BucketAlreadyOwnedByYou`
 * (409), which is the outcome the restore wants, not an error (JD-S4 R7 B-S5). Any other refusal is thrown.
 */
export async function ensureBucket(
  client: BucketClient,
  bucket: string,
  retry: RetryOptions = {},
): Promise<void> {
  try {
    await withTransientRetry(() => client.send(new HeadBucketCommand({ Bucket: bucket })), retry);
    return;
  } catch {
    // Not there (or not answering): create it.
  }
  try {
    await withTransientRetry(() => client.send(new CreateBucketCommand({ Bucket: bucket })), retry);
  } catch (error) {
    if ((error as { name?: unknown }).name === 'BucketAlreadyOwnedByYou') return;
    throw error;
  }
}
