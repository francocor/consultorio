import { describe, expect, it, vi } from 'vitest';

import { DEMO_CONTRIBUTORS, runContributors, type DemoContributorContext } from './contributors.js';
import { seedStage3 } from './stage3/index.js';
import { seedStage4 } from './stage4/index.js';

const context = { tenantId: 'tenant-1' } as unknown as DemoContributorContext;

describe('the demo contributors', () => {
  it('runs each one in order with the context of the seed, waiting for it before the next', async () => {
    const order: string[] = [];
    const first = vi.fn(async (received: DemoContributorContext) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`first:${received.tenantId}`);
    });
    const second = vi.fn((received: DemoContributorContext) => {
      order.push(`second:${received.tenantId}`);
      return Promise.resolve();
    });

    await runContributors(context, [first, second]);

    expect(order).toEqual(['first:tenant-1', 'second:tenant-1']);
    expect(first).toHaveBeenCalledWith(context);
  });

  it('stops at the first one that fails, so a half-seeded demo is not hidden', async () => {
    const after = vi.fn(() => Promise.resolve());

    await expect(
      runContributors(context, [() => Promise.reject(new Error('seed broke')), after]),
    ).rejects.toThrow('seed broke');
    expect(after).not.toHaveBeenCalled();
  });

  it('registers the Stage 3 seed (engagement) and then the Stage 4 one (revenue, which reads the visits), and nothing else yet', () => {
    expect(DEMO_CONTRIBUTORS).toEqual([seedStage3, seedStage4]);
  });
});
