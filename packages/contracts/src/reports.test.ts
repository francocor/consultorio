import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import { REPORTS_AUDIT_ACTIONS, REPORTS_ERRORS, REPORT_MAX_SPAN_DAYS } from './reports.js';

describe('reports catalogues', () => {
  it('limits a report to a span of 366 days (the range filter rejects more)', () => {
    expect(REPORT_MAX_SPAN_DAYS).toBe(366);
  });

  it('registers its audit action in the shared catalogue', () => {
    expect(REPORTS_AUDIT_ACTIONS).toEqual(['report.accessed']);
    for (const action of REPORTS_AUDIT_ACTIONS) expect(AUDIT_ACTIONS).toContain(action);
  });

  it('starts with no error codes of its own: the track adds them to its catalog', () => {
    expect(Object.keys(REPORTS_ERRORS)).toEqual([]);
  });
});
