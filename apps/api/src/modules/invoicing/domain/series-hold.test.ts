import { describe, expect, it } from 'vitest';

import { blockerOf, heldCount, type SeriesMember } from './series-hold.js';

const member = (id: string, awaiting = false): SeriesMember => ({ id, awaiting });

describe('blockerOf', () => {
  it('is nothing when no invoice of the series waits for reconciliation', () => {
    const series = [member('a'), member('b')];

    expect(blockerOf(member('a'), series)).toBeUndefined();
  });

  it('is the oldest invoice that waits, for an invoice that was not sent', () => {
    const series = [member('c'), member('b', true), member('a', true)];

    expect(blockerOf(member('c'), series)?.id).toBe('a');
  });

  it('holds back an invoice that waits too only when an older one waits', () => {
    const series = [member('a', true), member('b', true)];

    expect(blockerOf(member('b', true), series)?.id).toBe('a');
    expect(blockerOf(member('a', true), series)).toBeUndefined();
  });

  it('never holds an invoice back by itself', () => {
    expect(blockerOf(member('a', true), [member('a', true)])).toBeUndefined();
  });
});

describe('heldCount', () => {
  it('counts every invoice of the series the blocker holds back', () => {
    const series = [member('a', true), member('b', true), member('c'), member('d')];

    expect(heldCount('a', series)).toBe(3);
    expect(heldCount('b', series)).toBe(0);
  });
});
