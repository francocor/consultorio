import { describe, expect, it } from 'vitest';

import { contrastRatio, relativeLuminance } from './contrast.js';

describe('contrast', () => {
  it('matches the WCAG reference values', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    // Mid grey #767676 on white is the classic 4.54:1 boundary of AA.
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 1);
  });

  it('is symmetric and accepts short hex and no hash', () => {
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(contrastRatio('#000000', '#ffffff'), 5);
    expect(contrastRatio('0f766e', '#ffffff')).toBeCloseTo(contrastRatio('#0f766e', '#fff'), 5);
  });

  it('rejects a color it cannot read', () => {
    expect(() => contrastRatio('teal', '#ffffff')).toThrow(/color/i);
  });
});
