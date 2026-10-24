import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_IN_FLIGHT_PIN_MS,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  callWithin,
  withinTime,
} from './common.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('withinTime (JD-S5 R1-B-T10)', () => {
  it('gives the answer of a call that comes in time', async () => {
    expect(await withinTime({}, () => Promise.resolve('answer'), 'fallback')).toBe('answer');
  });

  it('gives the fallback when the call fails, also when it fails before it returns a promise', async () => {
    expect(await withinTime({}, () => Promise.reject(new Error('down')), 'fallback')).toBe(
      'fallback',
    );
    expect(
      await withinTime(
        {},
        () => {
          throw new Error('synchronously');
        },
        'fallback',
      ),
    ).toBe('fallback');
  });

  it('gives the fallback when the call does not come back in time, and stops the timer otherwise', async () => {
    vi.useFakeTimers();
    const pending = withinTime(
      { providerTimeoutMs: 50 },
      () => new Promise<string>(() => undefined),
      'late',
    );

    await vi.advanceTimersByTimeAsync(60);

    expect(await pending).toBe('late');
    const quick = withinTime({}, () => Promise.resolve('quick'), 'late');
    expect(await quick).toBe('quick');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits twenty seconds by default', () => {
    expect(DEFAULT_PROVIDER_TIMEOUT_MS).toBe(20_000);
  });

  it('waits ten minutes by default before it believes that nothing is in flight at the provider', () => {
    expect(DEFAULT_IN_FLIGHT_PIN_MS).toBe(600_000);
  });
});

describe('callWithin (JD-S5 R2-3)', () => {
  it('says whether it gave up waiting, and aborts the signal it handed the call', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const pending = callWithin(
      { providerTimeoutMs: 50 },
      (signal) => {
        seen = signal;
        return new Promise<string>(() => undefined);
      },
      'late',
    );

    await Promise.resolve();
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60);

    expect(await pending).toEqual({ value: 'late', timedOut: true });
    expect(seen?.aborted).toBe(true);
  });

  it('is not a timeout when the call fails fast or answers in time', async () => {
    expect(await callWithin({}, () => Promise.reject(new Error('down')), 'fallback')).toEqual({
      value: 'fallback',
      timedOut: false,
    });
    expect(await callWithin({}, () => Promise.resolve('answer'), 'fallback')).toEqual({
      value: 'answer',
      timedOut: false,
    });
  });
});
