import { describe, expect, it, vi } from 'vitest';

import { isTransientNetworkError, withTransientRetry } from './retry.js';

const reset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
const noWait = () => Promise.resolve();

describe('what counts as a transient network error', () => {
  it.each([
    ['a connection reset', reset()],
    ['a socket that hung up', new Error('socket hang up')],
    ['a timeout', Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })],
    ['a broken pipe', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })],
    [
      'a server error of the store',
      Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 503 } }),
    ],
    ['a reset wrapped by the SDK', Object.assign(new Error('failed'), { cause: reset() })],
    [
      'the SDK timeout error, with no code',
      Object.assign(new Error('read ECONNRESET'), { name: 'TimeoutError' }),
    ],
    ['a TimeoutError whatever it says', Object.assign(new Error('x'), { name: 'TimeoutError' })],
    ['a reset named only in the message', new Error('write EPIPE while sending')],
    ['a timeout named only in the message', new Error('connect ETIMEDOUT 127.0.0.1:9000')],
    [
      'an SDK error that says it is retryable',
      Object.assign(new Error('slow down'), { $retryable: {} }),
    ],
  ])('treats %s as transient', (_name, error) => {
    expect(isTransientNetworkError(error)).toBe(true);
  });

  it.each([
    ['a missing bucket', Object.assign(new Error('no bucket'), { name: 'NoSuchBucket' })],
    ['a refusal', Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } })],
    ['our own guard', new Error('the target bucket x is not empty')],
    ['a word that only contains a code', new Error('NOT_ECONNRESETTABLE')],
    ['something that is not an error', 'ECONNRESET'],
  ])('does not treat %s as transient', (_name, error) => {
    expect(isTransientNetworkError(error)).toBe(false);
  });
});

describe('withTransientRetry', () => {
  it('returns the result when the first call works', async () => {
    const call = vi.fn(() => Promise.resolve('ok'));

    await expect(withTransientRetry(call, { wait: noWait })).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('tries again after a connection reset and returns what the next call gives', async () => {
    const call = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(reset())
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue('ok');

    await expect(withTransientRetry(call, { wait: noWait })).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('gives up after a bounded number of attempts and throws the last error', async () => {
    const call = vi.fn(() => Promise.reject(reset()));

    await expect(withTransientRetry(call, { attempts: 4, wait: noWait })).rejects.toThrow(
      'ECONNRESET',
    );
    expect(call).toHaveBeenCalledTimes(4);
  });

  it('does not retry an error that is not transient: it fails at once', async () => {
    const refusal = Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } });
    const call = vi.fn(() => Promise.reject(refusal));

    await expect(withTransientRetry(call, { wait: noWait })).rejects.toBe(refusal);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('waits longer before each new attempt', async () => {
    const waits: number[] = [];
    const call = vi.fn(() => Promise.reject(reset()));

    await withTransientRetry(call, {
      attempts: 4,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    }).catch(() => undefined);

    expect(waits).toHaveLength(3);
    expect(waits[1]).toBeGreaterThan(waits[0] ?? 0);
    expect(waits[2]).toBeGreaterThan(waits[1] ?? 0);
  });
});
