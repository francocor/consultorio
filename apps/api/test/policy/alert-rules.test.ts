import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { METRIC_CATALOG, metricNamesIn } from '../../src/platform/metrics-catalog.js';

/**
 * The alert rules are code (task 6.45, `infra/alerts/rules.yml`). Prometheus validates the syntax (the
 * CI job runs promtool); what only this repository can validate is that a rule watches something the
 * application really exposes, and that whoever is woken by it is told where to read what to do.
 */

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const text = readFileSync(`${REPO}infra/alerts/rules.yml`, 'utf8');

/** What Prometheus itself provides: the scraper adds `up`. */
const BUILT_IN = new Set(['up']);

interface Rule {
  alert: string;
  /** Absent when the file does not give it: the tests then fail on that rule by name. */
  expr?: string;
  for?: string;
  severity?: string;
  summary?: string;
  runbook?: string;
}

/** Reads the file as it is written (one key per line, one rule per `- alert:`); anything else is a failure. */
function rulesOf(source: string): Rule[] {
  const rules: Partial<Rule>[] = [];
  for (const line of source.split('\n')) {
    const alert = /^\s*- alert:\s*(\S+)\s*$/.exec(line);
    if (alert?.[1]) {
      rules.push({ alert: alert[1] });
      continue;
    }
    const field = /^\s+(expr|for|severity|summary|runbook):\s*(.+?)\s*$/.exec(line);
    const current = rules.at(-1);
    if (field?.[1] && field[2] && current) {
      current[field[1] as 'expr'] = field[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  }
  return rules as Rule[];
}

describe('the alert rules', () => {
  const rules = rulesOf(text);

  it('are there, in groups, with a name each', () => {
    expect(text).toMatch(/^groups:/m);
    expect(rules.length).toBeGreaterThanOrEqual(12);
    expect(new Set(rules.map((rule) => rule.alert)).size).toBe(rules.length);
  });

  it('say how bad it is, what happened and where to read what to do', () => {
    for (const rule of rules) {
      expect(['info', 'warning', 'critical'], rule.alert).toContain(rule.severity ?? '');
      expect(rule.summary?.length ?? 0, rule.alert).toBeGreaterThan(20);
      expect(rule.for ?? '', rule.alert).toMatch(/^\d+[smh]$/);
      const [file, anchor] = (rule.runbook ?? '').split('#');
      expect(existsSync(`${REPO}${file ?? ''}`), `${rule.alert}: ${rule.runbook ?? ''}`).toBe(true);
      if (anchor) {
        const body = readFileSync(`${REPO}${file ?? ''}`, 'utf8');
        const headings = [...body.matchAll(/^#{1,4} (.+)$/gm)].map((match) =>
          (match[1] ?? '')
            .toLowerCase()
            .replaceAll(/[^a-z0-9 -]/g, '')
            .trim()
            .replaceAll(' ', '-'),
        );
        expect(headings, `${rule.alert}: no section "${anchor}" in ${file ?? ''}`).toContain(
          anchor,
        );
      }
    }
  });

  it('read only series that the application exposes (or that Prometheus adds)', () => {
    for (const rule of rules) {
      const names = metricNamesIn(rule.expr ?? '');
      expect(names.length, rule.alert).toBeGreaterThan(0);
      for (const name of names) {
        expect(name in METRIC_CATALOG || BUILT_IN.has(name), `${rule.alert} reads ${name}`).toBe(
          true,
        );
      }
    }
  });

  it('watch what the operations of the platform depend on', () => {
    const watched = new Set(rules.flatMap((rule) => metricNamesIn(rule.expr ?? '')));

    for (const name of [
      'queue_jobs',
      'queue_oldest_waiting_seconds',
      'messages_last_day',
      'invoices_pending_past_threshold',
      'documents_scan_oldest_waiting_seconds',
      'audit_oldest_unsealed_seconds',
      'audit_chain_break_total',
      'platform_audit_chain_break_total',
      'subscription_dunning_step',
      'platform_metrics_collected_at_seconds',
    ]) {
      expect(watched.has(name), `no rule reads ${name}`).toBe(true);
    }
  });

  it('does not call a person for a subscription that only waits for its owner to authorize an amount', () => {
    const parked = rules.find((rule) => rule.alert === 'SubscriptionParked');
    const waiting = rules.find((rule) => rule.alert === 'SubscriptionReauthorizationWaiting');

    // `reauthorization_needed` is not an ambiguity at the provider: it clears by itself when the owner
    // authorizes, so the page about subscriptions parked for a person leaves it out.
    expect(parked?.expr).toContain('subscriptions_parked{reason!="reauthorization_needed"}');
    expect(waiting?.expr).toContain('subscriptions_parked{reason="reauthorization_needed"}');
    expect(waiting?.severity).toBe('info');
    expect(waiting?.runbook).toBe(parked?.runbook);
  });

  it('is refused by the check itself when a rule reads a name nobody exposes', () => {
    const broken = rulesOf(
      `groups:\n  - name: x\n    rules:\n      - alert: Typo\n        expr: "queue_jobz > 5"\n`,
    );

    expect(metricNamesIn(broken[0]?.expr ?? '')).toEqual(['queue_jobz']);
    expect('queue_jobz' in METRIC_CATALOG).toBe(false);
  });
});
