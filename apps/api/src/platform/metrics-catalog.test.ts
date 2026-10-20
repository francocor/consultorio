import { describe, expect, it } from 'vitest';

import { METRIC_CATALOG, metricNamesIn } from './metrics-catalog.js';

describe('the catalog of metrics', () => {
  const entries = Object.entries(METRIC_CATALOG);

  it('names every metric the alert rules need, each described', () => {
    for (const name of [
      'queue_jobs',
      'queue_oldest_waiting_seconds',
      'messages_last_day',
      'invoices_pending_past_threshold',
      'documents_scan_backlog',
      'audit_seal_lag_seconds',
      'audit_chain_break_total',
      'platform_audit_chain_break_total',
      'subscriptions',
      'subscription_dunning_step',
    ]) {
      expect(METRIC_CATALOG[name]?.help, name).toBeTruthy();
    }
  });

  it('follows the naming of Prometheus: lower case with underscores, and a counter ends in _total', () => {
    expect(entries.length).toBeGreaterThan(15);
    for (const [name, description] of entries) {
      expect(name, name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(description.help.length, name).toBeGreaterThan(10);
      expect(name.endsWith('_total'), name).toBe(description.type === 'counter');
    }
  });

  it('keeps patient data out of the labels it documents', () => {
    for (const [name, description] of entries) {
      expect(description.labels ?? [], name).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/patient|name|email|document|phone/i)]),
      );
    }
  });
});

describe('metricNamesIn', () => {
  it('finds the metrics an expression of an alert reads, and not its functions or its labels', () => {
    expect(
      metricNamesIn(
        'sum(queue_jobs{queue="dunning.step",state="created"}) > 50 and max_over_time(audit_seal_lag_seconds[5m]) > 300',
      ),
    ).toEqual(['audit_seal_lag_seconds', 'queue_jobs']);
  });

  it('finds the metrics of a ratio and ignores numbers, durations and keywords', () => {
    expect(
      metricNamesIn(
        'messages_last_day{status="failed"} / ignoring(status) sum(messages_last_day) > 0.25 unless on() vector(0)',
      ),
    ).toEqual(['messages_last_day']);
  });

  it('finds nothing in an expression that reads no metric', () => {
    expect(metricNamesIn('vector(1) > 0')).toEqual([]);
  });
});
