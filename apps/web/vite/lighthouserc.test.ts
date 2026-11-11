import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface Assertion extends Array<unknown> {
  0: 'error' | 'warn';
  1: { maxNumericValue?: number; minScore?: number };
}

const config = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../lighthouserc.json'), 'utf8'),
) as {
  ci: {
    collect: {
      url: string[];
      numberOfRuns: number;
      settings: {
        formFactor: string;
        throttlingMethod: string;
        throttling: { cpuSlowdownMultiplier: number; throughputKbps: number; rttMs: number };
      };
    };
    assert: { assertions: Record<string, Assertion> };
  };
};

describe('Lighthouse budget (SHL-04)', () => {
  const { assertions } = config.ci.assert;

  it('fails the build when LCP exceeds 2.5 s or performance drops under 0.85', () => {
    expect(assertions['largest-contentful-paint']?.[0]).toBe('error');
    expect(assertions['largest-contentful-paint']?.[1].maxNumericValue).toBe(2500);
    expect(assertions['categories:performance']?.[0]).toBe('error');
    expect(assertions['categories:performance']?.[1].minScore).toBe(0.85);
  });

  it('measures what the budget means: a phone on a 4G connection with a slow processor', () => {
    const { settings } = config.ci.collect;

    expect(settings.formFactor).toBe('mobile');
    expect(settings.throttlingMethod).toBe('simulate');
    expect(settings.throttling.cpuSlowdownMultiplier).toBeGreaterThanOrEqual(4);
    // 4G: about 9 Mbps down with a 170 ms round trip; anything faster would not be a 4G profile.
    expect(settings.throttling.throughputKbps).toBeLessThanOrEqual(9000);
    expect(settings.throttling.rttMs).toBeGreaterThanOrEqual(150);
  });

  it('takes the median of several runs, so one noisy run neither fails nor hides a regression', () => {
    expect(config.ci.collect.numberOfRuns).toBeGreaterThanOrEqual(3);
    expect(config.ci.collect.url).toEqual(['http://localhost:4173/login']);
  });

  it('also guards accessibility and layout shifts', () => {
    expect(assertions['categories:accessibility']?.[1].minScore).toBeGreaterThanOrEqual(0.95);
    expect(assertions['cumulative-layout-shift']?.[1].maxNumericValue).toBeLessThanOrEqual(0.1);
  });
});
