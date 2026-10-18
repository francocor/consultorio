import { describe, expect, it } from 'vitest';

import { noShowRateBp, ratioBp } from './rates.js';

describe('ratioBp', () => {
  it('is the ratio in basis points, rounded half up', () => {
    expect(ratioBp(12, 100)).toBe(1200);
    expect(ratioBp(1, 3)).toBe(3333);
    expect(ratioBp(2, 3)).toBe(6667);
    expect(ratioBp(1, 8)).toBe(1250);
    expect(ratioBp(1, 16)).toBe(625);
    expect(ratioBp(1, 32)).toBe(313);
  });

  it('is null when there is nothing to divide by, not 0%', () => {
    expect(ratioBp(0, 0)).toBeNull();
    expect(ratioBp(5, 0)).toBeNull();
  });

  it('can be 0% and 100%', () => {
    expect(ratioBp(0, 10)).toBe(0);
    expect(ratioBp(10, 10)).toBe(10000);
  });
});

describe('noShowRateBp (D9: no-show / (attended + no-show))', () => {
  it('gives 12% for 88 attended and 12 no-show', () => {
    expect(noShowRateBp({ attended: 88, noShow: 12 })).toBe(1200);
  });

  it('is null when no appointment reached a final attendance state', () => {
    expect(noShowRateBp({ attended: 0, noShow: 0 })).toBeNull();
  });

  it('is 0% when everyone came and 100% when nobody did', () => {
    expect(noShowRateBp({ attended: 5, noShow: 0 })).toBe(0);
    expect(noShowRateBp({ attended: 0, noShow: 5 })).toBe(10000);
  });
});
