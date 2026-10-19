import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import { ensureBucket } from './bucket.js';

const reset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
const missing = () => Object.assign(new Error('not found'), { name: 'NotFound' });
const owned = () =>
  Object.assign(new Error('You already own it'), {
    name: 'BucketAlreadyOwnedByYou',
    $metadata: { httpStatusCode: 409 },
  });
const noWait = () => Promise.resolve();

/** A client whose answers are scripted by the name of the command. */
function clientWith(answers: Record<string, (() => Promise<unknown>)[]>) {
  const calls: string[] = [];
  return {
    calls,
    send: vi.fn((command: object) => {
      const name = command.constructor.name;
      calls.push(name);
      const next = answers[name]?.shift();
      if (!next) throw new Error(`no scripted answer for ${name}`);
      return next();
    }),
  };
}

describe('ensureBucket (JD-S4 R7 suspect B-S5)', () => {
  it('does nothing when the bucket exists', async () => {
    const client = clientWith({ HeadBucketCommand: [() => Promise.resolve({})] });

    await ensureBucket(client, 'documents', { wait: noWait });

    expect(client.calls).toEqual([HeadBucketCommand.name]);
  });

  it('creates the bucket when it is missing', async () => {
    const client = clientWith({
      HeadBucketCommand: [() => Promise.reject(missing())],
      CreateBucketCommand: [() => Promise.resolve({})],
    });

    await ensureBucket(client, 'documents', { wait: noWait });

    expect(client.calls).toEqual([HeadBucketCommand.name, CreateBucketCommand.name]);
  });

  it('takes "already owned by you" after a retried create as success: the first create went through', async () => {
    const client = clientWith({
      HeadBucketCommand: [() => Promise.reject(missing())],
      // The first create reached the store and the connection was reset before the answer came back.
      CreateBucketCommand: [() => Promise.reject(reset()), () => Promise.reject(owned())],
    });

    await expect(ensureBucket(client, 'documents', { wait: noWait })).resolves.toBeUndefined();

    expect(client.calls.filter((name) => name === CreateBucketCommand.name)).toHaveLength(2);
  });

  it('does not hide a refusal that is not an already owned bucket', async () => {
    const denied = Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } });
    const client = clientWith({
      HeadBucketCommand: [() => Promise.reject(missing())],
      CreateBucketCommand: [() => Promise.reject(denied)],
    });

    await expect(ensureBucket(client, 'documents', { wait: noWait })).rejects.toBe(denied);
  });
});
