import { describe, expect, it } from 'vitest';

import { findCountProblems } from './counts.js';
import { drillPassed, formatReport, type DrillReport } from './report.js';

describe('the row counts of the restored copy', () => {
  it('accepts a copy that has exactly the rows the source had', () => {
    const counts = { patient: 12, audit_event: 400 };

    expect(findCountProblems(counts, counts, counts)).toEqual([]);
  });

  it('accepts a table that moved while the dump was being taken, as long as the copy is between the two counts', () => {
    expect(
      findCountProblems({ job_execution: 10 }, { job_execution: 14 }, { job_execution: 12 }),
    ).toEqual([]);
  });

  it('flags a table that came back with fewer rows, one with more than the source ever had, and one that is missing', () => {
    const before = { patient: 12, audit_event: 400, session: 3 };
    const after = { patient: 12, audit_event: 400, session: 3 };

    expect(findCountProblems(before, after, { patient: 11, audit_event: 401 })).toEqual([
      { table: 'audit_event', before: 400, after: 400, restored: 401 },
      { table: 'patient', before: 12, after: 12, restored: 11 },
      { table: 'session', before: 3, after: 3, restored: null },
    ]);
  });

  it('flags a table the copy has and the source never had', () => {
    expect(findCountProblems({}, {}, { surprise: 2 })).toEqual([
      { table: 'surprise', before: null, after: null, restored: 2 },
    ]);
  });
});

const passing = (): DrillReport => ({
  startedAt: '2026-10-20T15:00:00.000Z',
  durationMs: 41_250,
  backup: { folder: 'backup-20261020T150000Z', databaseBytes: 1_234_567, objects: 3 },
  store: { bucket: 'consultorio-backups', prefix: 'drill/backup-20261020T150000Z', files: 6 },
  restore: { database: 'drill_20261020t150000z', tables: 140, objects: 3 },
  counts: { tables: 140, rows: 5_400, problems: [] },
  chains: {
    tenants: 3,
    tenantsWithEvents: 2,
    eventsVerified: 812,
    platformEventsVerified: 7,
    breaks: [],
  },
});

describe('the report of the drill', () => {
  it('passes when the copy has every row and every chain verifies', () => {
    expect(drillPassed(passing())).toBe(true);
    const text = formatReport(passing());
    expect(text).toContain('PASSED');
    expect(text).toContain('812 events');
    expect(text).toContain('41.3 s');
  });

  it('fails on a chain that breaks, and says where', () => {
    const report = passing();
    report.chains.breaks = [{ scope: 'tenant 0190a000', firstBadSeq: 42, reason: 'hash_mismatch' }];

    expect(drillPassed(report)).toBe(false);
    const text = formatReport(report);
    expect(text).toContain('FAILED');
    expect(text).toContain('tenant 0190a000: the chain breaks at event 42 (hash_mismatch)');
  });

  it('fails on a count that does not match, and says which table', () => {
    const report = passing();
    report.counts.problems = [{ table: 'patient', before: 12, after: 12, restored: 11 }];

    expect(drillPassed(report)).toBe(false);
    expect(formatReport(report)).toContain('patient: the source had 12 rows, the copy has 11');
  });

  it('fails when it verified nothing: a drill over an empty trail proves nothing', () => {
    const report = passing();
    report.chains.eventsVerified = 0;
    report.chains.platformEventsVerified = 0;

    expect(drillPassed(report)).toBe(false);
    expect(formatReport(report)).toContain('no audit event was verified');
  });
});
