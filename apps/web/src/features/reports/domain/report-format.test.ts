import { describe, expect, it } from 'vitest';

import { formatDuration, formatRate } from './report-format.js';

describe('formatRate (basis points, es-AR)', () => {
  it('writes a whole percentage without decimals', () => {
    expect(formatRate(1200)).toBe('12%');
    expect(formatRate(10000)).toBe('100%');
    expect(formatRate(0)).toBe('0%');
  });

  it('keeps one decimal, with a comma', () => {
    expect(formatRate(3333)).toBe('33,3%');
    expect(formatRate(1250)).toBe('12,5%');
  });

  it('says there is no figure, instead of 0%, when there was nothing to divide', () => {
    expect(formatRate(null)).toBe('–');
  });
});

describe('formatDuration (minutes)', () => {
  it('shows hours and minutes', () => {
    expect(formatDuration(90)).toBe('1 h 30 min');
    expect(formatDuration(240)).toBe('4 h');
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(0)).toBe('0 min');
  });

  it('groups thousands of hours the way es-AR does', () => {
    expect(formatDuration(60 * 1234)).toBe('1.234 h');
  });
});
