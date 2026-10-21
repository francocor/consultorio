import { describe, expect, it } from 'vitest';

import type { Tx } from '../../../platform/db/tenant-context.js';

import { createTenantLifecycle, type TenantCancelledEvent } from './lifecycle.js';

const tx = { id: 'the-transaction' } as unknown as Tx;
const event: TenantCancelledEvent = {
  tenantId: '0190a000-0000-7000-8000-0000000000c1',
  cancelledAt: new Date('2026-11-01T12:00:00.000Z'),
  source: 'subscription',
};

describe('the tenant lifecycle events', () => {
  it('hands every subscriber the event and the transaction that cancelled the organization, in order', async () => {
    const lifecycle = createTenantLifecycle();
    const calls: string[] = [];
    lifecycle.onCancelled((received, cancelled) => {
      calls.push(`first:${cancelled.source}:${(received as unknown as { id: string }).id}`);
      return Promise.resolve();
    });
    lifecycle.onCancelled(async (_received, cancelled) => {
      await Promise.resolve();
      calls.push(`second:${cancelled.tenantId}`);
    });

    await lifecycle.publishCancelled(tx, event);

    expect(calls).toEqual(['first:subscription:the-transaction', `second:${event.tenantId}`]);
  });

  it('carries who cancelled: the subscription reaching its end, or the operator', async () => {
    const lifecycle = createTenantLifecycle();
    const sources: string[] = [];
    lifecycle.onCancelled((_tx, cancelled) => {
      sources.push(cancelled.source);
      return Promise.resolve();
    });

    await lifecycle.publishCancelled(tx, event);
    await lifecycle.publishCancelled(tx, { ...event, source: 'operator' });

    expect(sources).toEqual(['subscription', 'operator']);
  });

  it('fails the publish when a subscriber fails, so the cancellation rolls back with it', async () => {
    const lifecycle = createTenantLifecycle();
    const reached: string[] = [];
    lifecycle.onCancelled(() => Promise.reject(new Error('the export could not be queued')));
    lifecycle.onCancelled(() => {
      reached.push('after');
      return Promise.resolve();
    });

    await expect(lifecycle.publishCancelled(tx, event)).rejects.toThrow(/could not be queued/);
    expect(reached).toEqual([]);
  });

  it('stops delivering to a subscriber that unsubscribed, without skipping its neighbour', async () => {
    const lifecycle = createTenantLifecycle();
    const calls: string[] = [];
    const stop = lifecycle.onCancelled(() => {
      calls.push('removed');
      stop();
      return Promise.resolve();
    });
    lifecycle.onCancelled(() => {
      calls.push('neighbour');
      return Promise.resolve();
    });

    await lifecycle.publishCancelled(tx, event);
    await lifecycle.publishCancelled(tx, event);

    expect(calls).toEqual(['removed', 'neighbour', 'neighbour']);
  });

  it('keeps one bus per lifecycle: another application does not see its subscribers', async () => {
    const one = createTenantLifecycle();
    const other = createTenantLifecycle();
    const calls: string[] = [];
    one.onCancelled(() => {
      calls.push('one');
      return Promise.resolve();
    });

    await other.publishCancelled(tx, event);

    expect(calls).toEqual([]);
  });
});
