import { describe, expect, it } from 'vitest';

import { createMetrics } from './metrics.js';

describe('in-memory metrics', () => {
  it('sets and reads a gauge by name and labels', () => {
    const metrics = createMetrics();

    metrics.gauge('audit_seal_lag_seconds', 12, { tenant: 'a' });
    metrics.gauge('audit_seal_lag_seconds', 3, { tenant: 'b' });

    expect(metrics.get('audit_seal_lag_seconds', { tenant: 'a' })).toBe(12);
    expect(metrics.get('audit_seal_lag_seconds', { tenant: 'b' })).toBe(3);
  });

  it('overwrites a gauge but accumulates a counter', () => {
    const metrics = createMetrics();

    metrics.gauge('lag', 5);
    metrics.gauge('lag', 2);
    metrics.increment('audit_chain_break_total', { tenant: 'a' });
    metrics.increment('audit_chain_break_total', { tenant: 'a' });
    metrics.increment('audit_chain_break_total', { tenant: 'b' }, 3);

    expect(metrics.get('lag')).toBe(2);
    expect(metrics.get('audit_chain_break_total', { tenant: 'a' })).toBe(2);
    expect(metrics.get('audit_chain_break_total', { tenant: 'b' })).toBe(3);
  });

  it('treats label order as irrelevant and an unknown series as zero', () => {
    const metrics = createMetrics();
    metrics.increment('x', { b: '2', a: '1' });

    expect(metrics.get('x', { a: '1', b: '2' })).toBe(1);
    expect(metrics.get('never_recorded')).toBe(0);
  });

  it('renders every series in a stable text form for scraping', () => {
    const metrics = createMetrics();
    metrics.increment('audit_chain_break_total', { tenant: 'a' });
    metrics.gauge('audit_seal_lag_seconds', 7);

    expect(metrics.render()).toBe(
      ['audit_chain_break_total{tenant="a"} 1', 'audit_seal_lag_seconds 7', ''].join('\n'),
    );
  });
});
