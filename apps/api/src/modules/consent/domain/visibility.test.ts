import { describe, expect, it } from 'vitest';

import { effectiveStatus, viewOfConsent, type Viewer } from './visibility.js';

const NOW = new Date('2031-05-01T12:00:00.000Z');
const PAST = new Date('2031-04-30T12:00:00.000Z');
const FUTURE = new Date('2031-05-02T12:00:00.000Z');

describe('effectiveStatus', () => {
  it('shows a pending request past its date as expired, and keeps every other state', () => {
    expect(effectiveStatus('pending', PAST, NOW)).toBe('expired');
    expect(effectiveStatus('pending', FUTURE, NOW)).toBe('pending');
    expect(effectiveStatus('signed', PAST, NOW)).toBe('signed');
    expect(effectiveStatus('revoked', PAST, NOW)).toBe('revoked');
    expect(effectiveStatus('declined', PAST, NOW)).toBe('declined');
  });

  it('counts a request as expired at the very instant of its date', () => {
    expect(effectiveStatus('pending', NOW, NOW)).toBe('expired');
  });
});

describe('viewOfConsent', () => {
  const base: Viewer = {
    kind: 'staff',
    roles: ['reception'],
    clinicalRead: false,
    receptionSeesClinicalMetadata: false,
  };

  it('gives a professional who may read the patient the title and the record', () => {
    const view = viewOfConsent({ ...base, roles: ['professional'], clinicalRead: true }, 'signed');
    expect(view).toEqual({ titleVisible: true, canOpen: true });
  });

  it('gives that professional a title but nothing to open while nobody has signed', () => {
    const view = viewOfConsent({ ...base, roles: ['professional'], clinicalRead: true }, 'pending');
    expect(view).toEqual({ titleVisible: true, canOpen: false });
  });

  it('keeps the title from a professional who may not read the patient', () => {
    const view = viewOfConsent({ ...base, roles: ['professional'], clinicalRead: false }, 'signed');
    expect(view).toEqual({ titleVisible: false, canOpen: false });
  });

  it('shows reception the title only when the organization allows it, and never the record', () => {
    expect(viewOfConsent(base, 'signed')).toEqual({ titleVisible: false, canOpen: false });
    expect(viewOfConsent({ ...base, receptionSeesClinicalMetadata: true }, 'signed')).toEqual({
      titleVisible: true,
      canOpen: false,
    });
  });

  it('never shows the administration a title, with the setting on', () => {
    for (const role of ['admin', 'owner'] as const) {
      const view = viewOfConsent(
        { ...base, roles: [role], receptionSeesClinicalMetadata: true },
        'revoked',
      );
      expect(view, role).toEqual({ titleVisible: false, canOpen: false });
    }
  });

  it('shows the patient their own title and lets them open what they signed', () => {
    const portal: Viewer = { kind: 'portal' };
    expect(viewOfConsent(portal, 'signed')).toEqual({ titleVisible: true, canOpen: true });
    expect(viewOfConsent(portal, 'revoked')).toEqual({ titleVisible: true, canOpen: true });
    expect(viewOfConsent(portal, 'pending')).toEqual({ titleVisible: true, canOpen: false });
    expect(viewOfConsent(portal, 'declined')).toEqual({ titleVisible: true, canOpen: false });
  });
});
