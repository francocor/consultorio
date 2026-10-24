import { describe, expect, it } from 'vitest';

import { AppError } from '../http/problem.js';
import { QUEUES } from '../jobs/queues.js';

import { JOB_CATEGORIES, assertTenantWritable, jobCategoryOf, jobMayRun } from './jobs.js';

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

describe('job classification (every queue declares one category)', () => {
  const STAGE_3_QUEUES = [
    'reminder.plan',
    'reminder.send',
    'reminder.sweep',
    'otp.send',
    'booking.purge',
    'tokens.purge',
    'waitlist.match',
    'waitlist.offer',
    'waitlist.expire',
    'video.link.create',
  ];

  it('classifies every queue the installer creates, and nothing else', () => {
    expect(Object.keys(JOB_CATEGORIES).sort()).toEqual(QUEUES.map((queue) => queue.name).sort());
  });

  it('keeps the audit trail sealing in a read-only tenant and cancels the Stage 3 messaging jobs', () => {
    expect(jobCategoryOf('audit.seal')).toBe('audit_write');
    for (const queue of STAGE_3_QUEUES) {
      expect(jobCategoryOf(queue), queue).toBe('write');
      expect(jobMayRun({ category: jobCategoryOf(queue) }, frozen, AFTER), queue).toEqual({
        run: false,
        reason: 'tenant_read_only',
      });
      expect(jobMayRun({ category: jobCategoryOf(queue) }, active, AFTER), queue).toEqual({
        run: true,
      });
    }
  });

  it('classifies the Stage 4 queues: exports and invoice PDFs keep running, messages are cancelled', () => {
    expect(jobCategoryOf('afip.issue')).toBe('afip_submission');
    expect(jobCategoryOf('export.build')).toBe('export');
    // A PDF is rendered from an invoice that already exists, which a read-only tenant may read.
    expect(jobCategoryOf('invoice.pdf')).toBe('export');
    // An email to a patient is a message: cancelled in a read-only tenant, never replayed.
    expect(jobCategoryOf('invoice.deliver')).toBe('write');
    expect(jobCategoryOf('fiscal.credential_watch')).toBe('write');
  });

  it('lets only afip.issue jobs queued before the freeze submit an invoice in a read-only tenant', () => {
    const afip = { category: jobCategoryOf('afip.issue') };

    expect(jobMayRun(afip, frozen, BEFORE)).toEqual({ run: true });
    expect(jobMayRun(afip, frozen, AFTER)).toEqual({ run: false, reason: 'tenant_read_only' });
    for (const queue of ['invoice.deliver', 'fiscal.credential_watch']) {
      expect(jobMayRun({ category: jobCategoryOf(queue) }, frozen, BEFORE).run, queue).toBe(false);
    }
    for (const queue of ['export.build', 'invoice.pdf']) {
      expect(jobMayRun({ category: jobCategoryOf(queue) }, frozen, AFTER).run, queue).toBe(true);
    }
  });

  it('classifies the Stage 5 queues: the provider mirror and the protection of a new adult keep running, the rest is cancelled', () => {
    // Issuing is a clinical write, and a read-only tenant refuses it: a retry is cancelled.
    expect(jobCategoryOf('erx.submit')).toBe('write');
    // The status of a prescription is the provider's to say, the same as its webhook.
    expect(jobCategoryOf('erx.reconcile')).toBe('webhook');
    expect(jobCategoryOf('consent.expire')).toBe('write');
    // A dependent who turns 18 must stop being seen by the representative, whatever the subscription.
    expect(jobCategoryOf('portal.majority_review')).toBe('patient_protective');
  });

  it('sends the sign-in code of the portal in a read-only tenant: signing in is authentication', () => {
    expect(jobCategoryOf('portal.code_send')).toBe('auth');
    expect(jobMayRun({ category: jobCategoryOf('portal.code_send') }, frozen, AFTER)).toEqual({
      run: true,
    });
    // The code of the public booking is a plain write: its pages are closed in a read-only tenant.
    expect(jobMayRun({ category: jobCategoryOf('otp.send') }, frozen, AFTER).run).toBe(false);
  });

  it('runs the Stage 5 jobs of the allowlisted categories in a read-only tenant, and cancels the others', () => {
    for (const queue of ['erx.reconcile', 'portal.majority_review']) {
      expect(jobMayRun({ category: jobCategoryOf(queue) }, frozen, AFTER).run, queue).toBe(true);
    }
    for (const queue of ['erx.submit', 'consent.expire']) {
      expect(jobMayRun({ category: jobCategoryOf(queue) }, frozen, AFTER), queue).toEqual({
        run: false,
        reason: 'tenant_read_only',
      });
    }
  });

  it('refuses a queue nobody classified instead of guessing a category', () => {
    expect(() => jobCategoryOf('made.up.queue')).toThrow(/made.up.queue/);
  });
});
