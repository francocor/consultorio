import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MIN_CONTRAST,
  contrastRatio,
  ensureAccessiblePrimary,
  hexToOklch,
  normalizeHex,
} from './contrast.js';

const hexColor = fc
  .tuple(
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
  )
  .map(
    ([r, g, b]) => `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`,
  );

describe('normalizeHex', () => {
  it.each([
    ['#0F766E', '#0f766e'],
    ['0f766e', '#0f766e'],
    ['#abc', '#aabbcc'],
    ['ABC', '#aabbcc'],
  ])('reads %s as %s', (input, expected) => {
    expect(normalizeHex(input)).toBe(expected);
  });

  it.each(['', '#12', '#12345', '#1234567', '#gggggg', 'rgb(1,2,3)', 'red', '#12 456', null, 12])(
    'refuses %j',
    (input) => {
      expect(normalizeHex(input as string)).toBeNull();
    },
  );
});

describe('contrastRatio (WCAG 2.x)', () => {
  it('is 21 between black and white, and 1 between a color and itself', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#0f766e', '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', '#0f766e'),
      10,
    );
  });

  it('matches known values', () => {
    // #767676 on white is the classic "just passes 4.5:1" gray.
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThan(4.5);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.6);
    expect(contrastRatio('#888888', '#ffffff')).toBeLessThan(4);
  });
});

describe('ensureAccessiblePrimary', () => {
  it('leaves a color that already passes untouched, and says nothing', () => {
    const result = ensureAccessiblePrimary('#0f766e');

    expect(result).toMatchObject({
      requested: '#0f766e',
      effective: '#0f766e',
      adjusted: false,
      warning: null,
      foreground: '#ffffff',
    });
    expect(result.ratio).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it('darkens a pale color until it reaches 4.5:1, warns, and keeps what was asked for', () => {
    const result = ensureAccessiblePrimary('#ffd54f');

    expect(result.requested).toBe('#ffd54f');
    expect(result.adjusted).toBe(true);
    expect(result.warning).toBe('branding.contrast_adjusted');
    expect(contrastRatio(result.effective, '#ffffff')).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(result.effective).not.toBe('#ffd54f');
    expect(hexToOklch(result.effective).l).toBeLessThan(hexToOklch('#ffd54f').l);
  });

  it('adjusts a mid color by the least it needs: the result is close to the limit, not black', () => {
    const result = ensureAccessiblePrimary('#2e9e8f');

    expect(result.adjusted).toBe(true);
    expect(result.ratio).toBeLessThan(MIN_CONTRAST + 0.35);
    expect(result.effective).not.toBe('#000000');
  });

  it('accepts shorthand and upper case, and reports the normalized request', () => {
    expect(ensureAccessiblePrimary('#0F766E').requested).toBe('#0f766e');
    expect(ensureAccessiblePrimary('#FFF').requested).toBe('#ffffff');
  });

  it('takes white to a dark, still neutral color', () => {
    const result = ensureAccessiblePrimary('#ffffff');

    expect(result.adjusted).toBe(true);
    expect(contrastRatio(result.effective, '#ffffff')).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(hexToOklch(result.effective).c).toBeLessThan(0.02);
  });

  it('refuses text that is not a color', () => {
    expect(() => ensureAccessiblePrimary('azul')).toThrow(/color/);
  });

  describe('properties', () => {
    it('always yields at least 4.5:1 against the foreground', () => {
      fc.assert(
        fc.property(hexColor, (color) => {
          const result = ensureAccessiblePrimary(color);
          expect(contrastRatio(result.effective, result.foreground)).toBeGreaterThanOrEqual(
            MIN_CONTRAST,
          );
          expect(result.ratio).toBeGreaterThanOrEqual(MIN_CONTRAST);
        }),
        { numRuns: 400 },
      );
    });

    it('keeps the hue of a color that has one', () => {
      fc.assert(
        fc.property(hexColor, (color) => {
          const before = hexToOklch(color);
          fc.pre(before.c > 0.05 && before.l > 0.25);
          const after = hexToOklch(ensureAccessiblePrimary(color).effective);
          const difference = Math.abs(((after.h - before.h + 540) % 360) - 180);
          expect(difference).toBeLessThanOrEqual(6);
        }),
        { numRuns: 400 },
      );
    });

    it('is idempotent: adjusting the result changes nothing', () => {
      fc.assert(
        fc.property(hexColor, (color) => {
          const once = ensureAccessiblePrimary(color).effective;
          const twice = ensureAccessiblePrimary(once);
          expect(twice.effective).toBe(once);
          expect(twice.adjusted).toBe(false);
        }),
        { numRuns: 400 },
      );
    });

    it('never lightens a color, and never touches one that passes', () => {
      fc.assert(
        fc.property(hexColor, (color) => {
          const result = ensureAccessiblePrimary(color);
          if (contrastRatio(color, '#ffffff') >= MIN_CONTRAST) {
            expect(result.effective).toBe(normalizeHex(color));
            expect(result.adjusted).toBe(false);
          } else {
            expect(hexToOklch(result.effective).l).toBeLessThanOrEqual(hexToOklch(color).l + 1e-6);
          }
        }),
        { numRuns: 400 },
      );
    });
  });
});
