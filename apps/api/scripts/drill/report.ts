import type { CountProblem } from './counts.js';

/** A chain of audit events that does not verify in the copy. */
export interface ChainBreak {
  /** `tenant <id>` or `platform`. */
  scope: string;
  firstBadSeq: number;
  reason: string;
}

/** What the restore drill did and found. Nothing in it is patient data: names of tables, counts, ids. */
export interface DrillReport {
  startedAt: string;
  durationMs: number;
  backup: { folder: string; databaseBytes: number; objects: number };
  /** Where the backup was kept while the drill restored from it (the S3 API of MinIO). */
  store: { bucket: string; prefix: string; files: number };
  restore: { database: string; tables: number; objects: number };
  counts: { tables: number; rows: number; problems: CountProblem[] };
  chains: {
    tenants: number;
    tenantsWithEvents: number;
    eventsVerified: number;
    platformEventsVerified: number;
    breaks: ChainBreak[];
  };
}

/**
 * The drill passes when every table came back with its rows, every chain of audit events verifies
 * from its first event, and something was verified at all (an empty trail proves nothing about the
 * copy).
 */
export function drillPassed(report: DrillReport): boolean {
  const verified = report.chains.eventsVerified + report.chains.platformEventsVerified;
  return report.counts.problems.length === 0 && report.chains.breaks.length === 0 && verified > 0;
}

const count = (value: number, noun: string) => `${String(value)} ${noun}`;

/** The report as the text the operator reads and records in the operations log. */
export function formatReport(report: DrillReport): string {
  const passed = drillPassed(report);
  const verified = report.chains.eventsVerified + report.chains.platformEventsVerified;
  const lines = [
    `Restore drill ${passed ? 'PASSED' : 'FAILED'} (${(report.durationMs / 1000).toFixed(1)} s, started ${report.startedAt})`,
    '',
    `Backup   ${report.backup.folder}: database ${count(report.backup.databaseBytes, 'bytes')}, ${count(report.backup.objects, 'objects')}`,
    `Store    ${report.store.bucket}/${report.store.prefix}: ${count(report.store.files, 'files')} written and read back`,
    `Restore  ${report.restore.database}: ${count(report.restore.tables, 'tables')}, ${count(report.restore.objects, 'objects')}`,
    `Counts   ${count(report.counts.tables, 'tables')} compared, ${count(report.counts.rows, 'rows')} in the copy, ${count(report.counts.problems.length, 'differences')}`,
    `Chains   ${count(report.chains.tenantsWithEvents, 'of')} ${count(report.chains.tenants, 'organizations')} with events: ${count(report.chains.eventsVerified, 'events')} verified, platform trail ${count(report.chains.platformEventsVerified, 'events')} verified`,
  ];
  for (const problem of report.counts.problems) {
    lines.push(
      `  ! ${problem.table}: the source had ${rangeOf(problem)} rows, the copy has ${problem.restored === null ? 'no such table' : String(problem.restored)}`,
    );
  }
  for (const chainBreak of report.chains.breaks) {
    lines.push(
      `  ! ${chainBreak.scope}: the chain breaks at event ${String(chainBreak.firstBadSeq)} (${chainBreak.reason})`,
    );
  }
  if (verified === 0)
    lines.push('  ! no audit event was verified: the trail is empty or was not read');
  return `${lines.join('\n')}\n`;
}

function rangeOf(problem: CountProblem): string {
  if (problem.before === null || problem.after === null) return 'no';
  return problem.before === problem.after
    ? String(problem.before)
    : `${String(problem.before)} to ${String(problem.after)}`;
}
