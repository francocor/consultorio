import { describe, expect, it } from 'vitest';

import { AppError } from '../http/problem.js';

import { assertTenantWritable, jobMayRun } from './jobs.js';

const SINCE = new Date('2026-10-01T12:00:00Z');
const BEFORE = new Date('2026-10-01T11:59:59Z');
const AFTER = new Date('2026-10-01T12:00:01Z');

const active = { status: 'active', readOnlySince: null } as const;
const frozen = { status: 'read_only', readOnlySince: SINCE } as const;

describe('jobMayRun', () => {
  it('lets every job run for an active tenant', () => {
    expect(jobMayRun({ category: 'write' }, active, AFTER)).toEqual({ run: true });
    expect(jobMayRun({ category: 'afip_submission' }, active, AFTER)).toEqual({ run: true });
  });

  it('cancels write jobs (reminders, offers, messages) in a read-only tenant, whenever they were queued', () => {
    const cancelled = { run: false, reason: 'tenant_read_only' };

    expect(jobMayRun({ category: 'write' }, frozen, BEFORE)).toEqual(cancelled);
    expect(jobMayRun({ category: 'write' }, frozen, AFTER)).toEqual(cancelled);
  });

  it('lets an AFIP submission queued BEFORE read_only_since run', () => {
    expect(jobMayRun({ category: 'afip_submission' }, frozen, BEFORE)).toEqual({ run: true });
  });

  it('cancels an AFIP submission queued at or after read_only_since', () => {
    expect(jobMayRun({ category: 'afip_submission' }, frozen, AFTER)).toEqual({
      run: false,
      reason: 'tenant_read_only',
    });
    expect(jobMayRun({ category: 'afip_submission' }, frozen, SINCE)).toEqual({
      run: false,
      reason: 'tenant_read_only',
    });
  });

  it('keeps allowlisted housekeeping running: audit sealing and exports never stop', () => {
    expect(jobMayRun({ category: 'audit_write' }, frozen, AFTER)).toEqual({ run: true });
    expect(jobMayRun({ category: 'export' }, frozen, AFTER)).toEqual({ run: true });
  });

  it('treats a cancelled tenant like a read-only one', () => {
    const cancelled = { status: 'cancelled', readOnlySince: null } as const;

    expect(jobMayRun({ category: 'write' }, cancelled, BEFORE).run).toBe(false);
    expect(jobMayRun({ category: 'audit_write' }, cancelled, BEFORE).run).toBe(true);
    // Without a read_only_since there is no "queued before" to honour: AFIP is cancelled too.
    expect(jobMayRun({ category: 'afip_submission' }, cancelled, BEFORE).run).toBe(false);
  });
});

describe('assertTenantWritable', () => {
  it('returns quietly when the job may run', () => {
    expect(() => {
      assertTenantWritable({ category: 'write' }, active, AFTER);
    }).not.toThrow();
  });

  it('throws tenant_read_only when it may not', () => {
    expect(() => {
      assertTenantWritable({ category: 'write' }, frozen, AFTER);
    }).toThrow(AppError);
    expect(() => {
      assertTenantWritable({ category: 'write' }, frozen, AFTER);
    }).toThrow(/tenant_read_only/);
  });
});
