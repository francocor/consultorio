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

  it('escapes the characters of a label value that the text format reserves', () => {
    const metrics = createMetrics();
    metrics.gauge('x', 1, { reason: 'a"b\\c\nd' });

    expect(metrics.render()).toBe('x{reason="a\\"b\\\\c\\nd"} 1\n');
  });

  it('writes the help and the type of a described metric once, above its series', () => {
    const metrics = createMetrics({
      catalog: {
        queue_jobs: { type: 'gauge', help: 'Jobs in the queue, by queue and state.' },
        errors_total: { type: 'counter', help: 'Failures.' },
      },
    });
    metrics.gauge('queue_jobs', 4, { queue: 'dunning.step', state: 'created' });
    metrics.gauge('queue_jobs', 1, { queue: 'archive.write', state: 'active' });
    metrics.increment('errors_total');
    metrics.gauge('not_described', 9);

    expect(metrics.render()).toBe(
      [
        '# HELP errors_total Failures.',
        '# TYPE errors_total counter',
        'errors_total 1',
        'not_described 9',
        '# HELP queue_jobs Jobs in the queue, by queue and state.',
        '# TYPE queue_jobs gauge',
        'queue_jobs{queue="archive.write",state="active"} 1',
        'queue_jobs{queue="dunning.step",state="created"} 4',
        '',
      ].join('\n'),
    );
  });

  it('forgets the series of a metric when it is replaced as a whole, so a queue that emptied does not stay at its last depth', () => {
    const metrics = createMetrics();
    metrics.gauge('queue_jobs', 4, { queue: 'a' });
    metrics.gauge('queue_jobs', 2, { queue: 'b' });

    metrics.replace('queue_jobs', [{ labels: { queue: 'b' }, value: 7 }]);

    expect(metrics.get('queue_jobs', { queue: 'a' })).toBe(0);
    expect(metrics.get('queue_jobs', { queue: 'b' })).toBe(7);
    expect(metrics.render()).toBe('queue_jobs{queue="b"} 7\n');
  });
});
