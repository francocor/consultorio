import { effectivePermissions, type AppointmentStatus, type Role } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { availableActions, correctionTargets } from './appointment-actions.js';

const NOW = new Date('2026-10-17T15:00:00Z');
const PAST = '2026-10-17T13:00:00Z';
const FUTURE = '2026-10-17T18:00:00Z';

function actions(
  status: AppointmentStatus,
  options: {
    roles?: Role[];
    startsAt?: string;
    ownProfessional?: boolean;
    grants?: string[];
  } = {},
) {
  const roles = options.roles ?? ['reception'];
  return availableActions({
    status,
    startsAt: options.startsAt ?? FUTURE,
    now: NOW,
    permissions: effectivePermissions(roles, options.grants ?? []),
    isOwnProfessional: options.ownProfessional ?? false,
  });
}

describe('which actions the drawer offers for each status (reception)', () => {
  it('pending approval can be approved, cancelled and moved', () => {
    expect(actions('pending_approval')).toEqual(['approve', 'cancel', 'reschedule']);
  });

  it('scheduled can be confirmed, checked in, cancelled and moved; no-show only after the start', () => {
    expect(actions('scheduled')).toEqual(['confirm', 'check_in', 'cancel', 'reschedule']);
    expect(actions('scheduled', { startsAt: PAST })).toEqual([
      'confirm',
      'check_in',
      'no_show',
      'cancel',
      'reschedule',
    ]);
  });

  it('confirmed can be checked in, cancelled and moved', () => {
    expect(actions('confirmed')).toEqual(['check_in', 'cancel', 'reschedule']);
  });

  it('checked in can be started or cancelled but not moved', () => {
    expect(actions('checked_in')).toEqual(['start', 'cancel']);
    expect(actions('checked_in', { startsAt: PAST })).toEqual(['start', 'no_show', 'cancel']);
  });

  it('in progress can only be finished', () => {
    expect(actions('in_progress')).toEqual(['attend']);
  });

  it('terminal statuses only offer the correction', () => {
    expect(actions('attended')).toEqual(['correct']);
    expect(actions('no_show')).toEqual(['correct']);
    expect(actions('cancelled')).toEqual(['correct']);
  });
});

describe('who sees an action', () => {
  it('a role without the booking permission cannot approve, cancel or move', () => {
    // An owner/admin has scheduling.book; a patient role has none of the scheduling permissions.
    expect(actions('scheduled', { roles: ['patient'] })).toEqual([]);
  });

  it('a professional works their own appointments through the same table', () => {
    expect(actions('checked_in', { roles: ['professional'], ownProfessional: true })).toEqual([
      'start',
      'cancel',
    ]);
    expect(actions('in_progress', { roles: ['professional'], ownProfessional: true })).toEqual([
      'attend',
    ]);
  });
});

describe('the status a correction may lead to', () => {
  it('never offers the current status or a pending approval', () => {
    const targets = correctionTargets('no_show', { isOwnProfessional: true });

    expect(targets).not.toContain('no_show');
    expect(targets).not.toContain('pending_approval');
  });

  it('keeps in progress and attended for the professional of the appointment', () => {
    expect(correctionTargets('no_show', { isOwnProfessional: true })).toEqual([
      'scheduled',
      'confirmed',
      'checked_in',
      'in_progress',
      'attended',
      'cancelled',
    ]);
    expect(correctionTargets('no_show', { isOwnProfessional: false })).toEqual([
      'scheduled',
      'confirmed',
      'checked_in',
      'cancelled',
    ]);
  });

  it('can bring a cancelled appointment back, but not out of a live status', () => {
    expect(correctionTargets('cancelled', { isOwnProfessional: false })).toContain('scheduled');
    expect(correctionTargets('scheduled', { isOwnProfessional: true })).toEqual([]);
  });
});
