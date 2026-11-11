import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDailyTicker, createTicker, msUntilNextDailyRun } from './ticker.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createTicker', () => {
  it('calls tick on every interval after start and stops after stop', async () => {
    const tick = vi.fn(() => Promise.resolve());
    const ticker = createTicker({ intervalMs: 5000, tick });

    ticker.start();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(2);

    await ticker.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('does nothing before start', async () => {
    const tick = vi.fn(() => Promise.resolve());
    createTicker({ intervalMs: 1000, tick });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(tick).not.toHaveBeenCalled();
  });

  it('never overlaps itself: an interval that arrives during a slow run is skipped', async () => {
    let release: () => void = () => undefined;
    const tick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const ticker = createTicker({ intervalMs: 1000, tick });

    ticker.start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(tick).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    release();
    await ticker.stop();
  });

  it('reports a failing tick and keeps running', async () => {
    const errors: unknown[] = [];
    const tick = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const ticker = createTicker({ intervalMs: 1000, tick, onError: (error) => errors.push(error) });

    ticker.start();
    await vi.advanceTimersByTimeAsync(2000);
    await ticker.stop();

    expect(tick).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
  });

  it('stop waits for a run in progress', async () => {
    let finished = false;
    const ticker = createTicker({
      intervalMs: 1000,
      tick: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        finished = true;
      },
    });
    ticker.start();
    await vi.advanceTimersByTimeAsync(1000);

    const stopping = ticker.stop();
    await vi.advanceTimersByTimeAsync(500);
    await stopping;

    expect(finished).toBe(true);
  });
});

describe('msUntilNextDailyRun', () => {
  it('counts to later today when the hour has not come yet', () => {
    expect(msUntilNextDailyRun(new Date('2026-10-15T01:00:00Z'), 3)).toBe(2 * 3600_000);
  });

  it('counts to tomorrow when the hour has passed or is exactly now', () => {
    expect(msUntilNextDailyRun(new Date('2026-10-15T04:00:00Z'), 3)).toBe(23 * 3600_000);
    expect(msUntilNextDailyRun(new Date('2026-10-15T03:00:00Z'), 3)).toBe(24 * 3600_000);
  });
});

describe('createDailyTicker', () => {
  it('runs at the chosen hour each day', async () => {
    vi.setSystemTime(new Date('2026-10-15T02:00:00Z'));
    const tick = vi.fn(() => Promise.resolve());
    const ticker = createDailyTicker({ hourUtc: 3, tick });

    ticker.start();
    await vi.advanceTimersByTimeAsync(3600_000 - 1);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(tick).toHaveBeenCalledTimes(2);

    await ticker.stop();
    await vi.advanceTimersByTimeAsync(48 * 3600_000);
    expect(tick).toHaveBeenCalledTimes(2);
  });
});
