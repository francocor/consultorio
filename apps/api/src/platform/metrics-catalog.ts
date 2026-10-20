import type { MetricDescription } from './metrics.js';

/** A metric of the catalog: what it is, and the labels its series carry (ids and short codes only). */
export interface CatalogEntry extends MetricDescription {
  labels?: readonly string[];
}

/**
 * Every series the application exposes on its `/metrics` port, with what it means. It is the one list
 * the alert rules are checked against (`infra/alerts/rules.yml`: a rule that reads a name that is not
 * here fails the build), so a rule cannot go on watching something that was renamed or never existed.
 *
 * Nothing here carries personal data: the labels are queue names, states, organization ids and short
 * reason codes. The counts are measured by the worker every minute (`main/platform-metrics.ts`); the
 * counters and the lags are kept by the processes that do the work.
 */
export const METRIC_CATALOG: Readonly<Record<string, CatalogEntry>> = {
  // The queues.
  queue_jobs: {
    type: 'gauge',
    help: 'Jobs in the queues that are waiting, being retried or running, by queue and state.',
    labels: ['queue', 'state'],
  },
  queue_oldest_waiting_seconds: {
    type: 'gauge',
    help: 'Age of the oldest job that is waiting or waiting to be retried, by queue.',
    labels: ['queue'],
  },

  // Messages (reminders, confirmations and offers).
  messages_last_day: {
    type: 'gauge',
    help: 'Messages created in the last 24 hours across the organizations, by status.',
    labels: ['status'],
  },

  // Invoices and documents.
  invoices_pending_past_threshold: {
    type: 'gauge',
    help: 'Invoices still pending after the hours of the outage threshold of their organization.',
  },
  documents_scan_backlog: {
    type: 'gauge',
    help: 'Uploaded documents that are still waiting for the malware scan.',
  },
  documents_scan_oldest_waiting_seconds: {
    type: 'gauge',
    help: 'Age of the document that has waited longest for the malware scan.',
  },
  document_scan_overdue_total: {
    type: 'counter',
    help: 'Documents that waited more than an hour for the malware scan, by organization.',
    labels: ['tenant'],
  },

  // The audit trail.
  audit_unsealed_events: {
    type: 'gauge',
    help: 'Audit events written and not yet sealed into the hash chain of their organization.',
  },
  audit_oldest_unsealed_seconds: {
    type: 'gauge',
    help: 'Age of the oldest audit event that is not sealed yet (the seal lag of the platform).',
  },
  audit_seal_lag_seconds: {
    type: 'gauge',
    help: 'Age of the oldest unsealed audit event of an organization, as the sealer last saw it.',
    labels: ['tenant'],
  },
  audit_chain_verified_events: {
    type: 'gauge',
    help: 'Events of the chain of an organization that the last verification walked.',
    labels: ['tenant'],
  },
  audit_chain_break_total: {
    type: 'counter',
    help: 'Breaks found in the audit chain of an organization by the nightly verification.',
    labels: ['tenant'],
  },
  platform_audit_chain_verified_events: {
    type: 'gauge',
    help: 'Events of the platform audit chain that the last verification walked.',
  },
  platform_audit_chain_break_total: {
    type: 'counter',
    help: 'Breaks found in the audit chain of the platform by the nightly verification.',
  },
  audit_partitions_ahead: {
    type: 'gauge',
    help: 'Months of audit partitions that already exist ahead of the current one.',
  },
  audit_partitions_created_total: {
    type: 'counter',
    help: 'Audit partitions created by the nightly upkeep.',
  },

  // Subscriptions.
  subscriptions: {
    type: 'gauge',
    help: 'Subscriptions across the organizations, by state.',
    labels: ['status'],
  },
  subscription_dunning_step: {
    type: 'gauge',
    help: 'Past due subscriptions, by the reminder of the dunning they have reached (0 to 3).',
    labels: ['step'],
  },
  tenants: {
    type: 'gauge',
    help: 'Organizations, by operational status.',
    labels: ['status'],
  },

  // Public surfaces.
  booking_suspicious_total: {
    type: 'counter',
    help: 'Public booking requests refused or flagged as abusive, by reason.',
    labels: ['reason'],
  },

  // The collector itself.
  platform_metrics_collected_at_seconds: {
    type: 'gauge',
    help: 'Unix time of the last time the worker measured the counts of the platform.',
  },
  platform_metrics_collection_errors_total: {
    type: 'counter',
    help: 'Times the worker could not measure the counts of the platform.',
  },
};

/** The same catalog in the shape the registry takes. */
export const METRIC_DESCRIPTIONS: Readonly<Record<string, MetricDescription>> = Object.fromEntries(
  Object.entries(METRIC_CATALOG).map(([name, { type, help }]) => [name, { type, help }]),
);

const KEYWORDS = new Set([
  'and',
  'or',
  'unless',
  'by',
  'without',
  'on',
  'ignoring',
  'group_left',
  'group_right',
  'bool',
  'offset',
  'inf',
  'nan',
]);

/**
 * The names of the metrics an expression of PromQL reads, sorted and without repeats. Strings, label
 * matchers, ranges, the label lists of `by` and `on`, function names and keywords are not metrics.
 */
export function metricNamesIn(expression: string): string[] {
  const bare = expression
    .replaceAll(/"(?:[^"\\]|\\.)*"/g, '""')
    .replaceAll(/\{[^}]*\}/g, '')
    .replaceAll(/\[[^\]]*\]/g, '')
    .replaceAll(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, '');
  const names = new Set<string>();
  for (const match of bare.matchAll(/[a-zA-Z_:][a-zA-Z0-9_:]*/g)) {
    const word = match[0];
    const after = bare.slice(match.index + word.length).trimStart();
    if (KEYWORDS.has(word) || after.startsWith('(')) continue;
    names.add(word);
  }
  return [...names].sort();
}
