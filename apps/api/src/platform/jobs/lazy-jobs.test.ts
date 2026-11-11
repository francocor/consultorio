import { describe, expect, it, vi } from 'vitest';

import type { Tx } from '../db/tenant-context.js';

import { createLazyJobs, type JobClient } from './boss.js';

const tx = {} as Tx;
const payload = { tenantId: '7b0e4a52-1f1d-4a53-bd8a-4a3f0d6f7c11' };

function fakes(start: () => Promise<unknown>) {
  const boss = { start: vi.fn(start), stop: vi.fn(() => Promise.resolve()) };
  const enqueue = vi.fn(() => Promise.resolve('job-1'));
  const inner: JobClient = { enqueue };
  return { boss, enqueue, lazy: createLazyJobs(boss, inner) };
}

describe('the lazily started job queue', () => {
  it('does not touch the database when it is built', () => {
    const { boss } = fakes(() => Promise.resolve());

    expect(boss.start).not.toHaveBeenCalled();
  });

  it('starts on the first enqueue, once, and enqueues through the real client', async () => {
    const { boss, enqueue, lazy } = fakes(() => Promise.resolve());

    await lazy.client.enqueue(tx, 'reminder.send', payload);
    await lazy.client.enqueue(tx, 'reminder.send', payload, { startAfter: new Date() });

    expect(boss.start).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('starts once even when two enqueues arrive together', async () => {
    const { boss, lazy } = fakes(() => new Promise((resolve) => setTimeout(resolve, 10)));

    await Promise.all([
      lazy.client.enqueue(tx, 'a', payload),
      lazy.client.enqueue(tx, 'b', payload),
    ]);

    expect(boss.start).toHaveBeenCalledTimes(1);
  });

  it('fails the enqueue while the database is down and tries again on the next one', async () => {
    let calls = 0;
    const { boss, enqueue, lazy } = fakes(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('connect ECONNREFUSED')) : Promise.resolve();
    });

    await expect(lazy.client.enqueue(tx, 'a', payload)).rejects.toThrow('ECONNREFUSED');
    expect(enqueue).not.toHaveBeenCalled();
    await expect(lazy.client.enqueue(tx, 'a', payload)).resolves.toBe('job-1');

    expect(boss.start).toHaveBeenCalledTimes(2);
  });

  it('stops a queue that was started, and does nothing for one that never was', async () => {
    const idle = fakes(() => Promise.resolve());
    await idle.lazy.stop({ graceful: true });
    expect(idle.boss.stop).not.toHaveBeenCalled();

    const used = fakes(() => Promise.resolve());
    await used.lazy.client.enqueue(tx, 'a', payload);
    await used.lazy.stop({ graceful: true });
    expect(used.boss.stop).toHaveBeenCalledWith({ graceful: true });
  });
});
