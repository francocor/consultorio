import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import { assertBucketEmpty } from './backup.js';

const target = { bucket: 'restore-target', region: 'us-east-1' };
const reset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

function clientAnswering(...answers: (() => Promise<unknown>)[]) {
  const send = vi.fn<() => Promise<unknown>>();
  for (const answer of answers) send.mockImplementationOnce(answer);
  const destroy = vi.fn();
  return { send, destroy, factory: () => ({ send, destroy }) as unknown as S3Client };
}

describe('the guard that a restore only fills an empty bucket', () => {
  it('refuses a bucket that has objects', async () => {
    const client = clientAnswering(() => Promise.resolve({ KeyCount: 1 }));

    await expect(assertBucketEmpty(target, client.factory)).rejects.toThrow(/not empty/);
  });

  it('accepts an empty bucket, and one that does not exist yet', async () => {
    const empty = clientAnswering(() => Promise.resolve({ KeyCount: 0 }));
    const missing = clientAnswering(() =>
      Promise.reject(Object.assign(new Error('no bucket'), { name: 'NoSuchBucket' })),
    );

    await expect(assertBucketEmpty(target, empty.factory)).resolves.toBeUndefined();
    await expect(assertBucketEmpty(target, missing.factory)).resolves.toBeUndefined();
  });

  it('asks again when the store resets the connection, and then checks what it answers', async () => {
    const refused = clientAnswering(
      () => Promise.reject(reset()),
      () => Promise.reject(reset()),
      () => Promise.resolve({ KeyCount: 3 }),
    );
    const accepted = clientAnswering(
      () => Promise.reject(reset()),
      () => Promise.resolve({ KeyCount: 0 }),
    );

    await expect(assertBucketEmpty(target, refused.factory)).rejects.toThrow(/not empty/);
    await expect(assertBucketEmpty(target, accepted.factory)).resolves.toBeUndefined();
  });

  it('fails closed on an error that is not a network failure: it is not retried and not swallowed', async () => {
    const denied = Object.assign(new Error('Access Denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    const client = clientAnswering(() => Promise.reject(denied));

    await expect(assertBucketEmpty(target, client.factory)).rejects.toBe(denied);
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the network keeps failing, instead of assuming the bucket is empty', async () => {
    const client = clientAnswering(
      () => Promise.reject(reset()),
      () => Promise.reject(reset()),
      () => Promise.reject(reset()),
      () => Promise.reject(reset()),
    );

    await expect(assertBucketEmpty(target, client.factory)).rejects.toThrow('ECONNRESET');
    expect(client.send).toHaveBeenCalledTimes(4);
  });

  it('closes the client in every case', async () => {
    const client = clientAnswering(() => Promise.resolve({ KeyCount: 1 }));
    await assertBucketEmpty(target, client.factory).catch(() => undefined);

    expect(client.destroy).toHaveBeenCalledTimes(1);
  });
});
