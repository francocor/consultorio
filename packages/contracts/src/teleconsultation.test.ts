import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import {
  DEFAULT_TELECONSULTATION_SETTINGS,
  TELECONSULTATION_AUDIT_ACTIONS,
  TeleconsultationSettings,
  VIDEO_SESSION_STATUSES,
} from './teleconsultation.js';

describe('teleconsultation catalogues', () => {
  it('has the video session statuses of the design', () => {
    expect([...VIDEO_SESSION_STATUSES]).toEqual(['ready', 'link_pending', 'closed']);
  });

  it('registers its audit actions in the shared catalogue', () => {
    expect(TELECONSULTATION_AUDIT_ACTIONS).toEqual([
      'video.link.created',
      'video.link.opened',
      'video.link.revoked',
      'video.link.joined',
      'video.link.manual_attached',
    ]);
    for (const action of TELECONSULTATION_AUDIT_ACTIONS) expect(AUDIT_ACTIONS).toContain(action);
  });
});

describe('teleconsultation settings', () => {
  it('opens the join window 15 minutes early and allows a no-show after 15 minutes', () => {
    expect(TeleconsultationSettings.parse(DEFAULT_TELECONSULTATION_SETTINGS)).toEqual({
      joinOpensMinutes: 15,
      noShowAfterMinutes: 15,
    });
  });

  it('bounds the minutes and refuses unknown keys', () => {
    const base = DEFAULT_TELECONSULTATION_SETTINGS;

    expect(TeleconsultationSettings.safeParse({ ...base, joinOpensMinutes: 0 }).success).toBe(true);
    expect(TeleconsultationSettings.safeParse({ ...base, joinOpensMinutes: -5 }).success).toBe(
      false,
    );
    expect(TeleconsultationSettings.safeParse({ ...base, noShowAfterMinutes: 0 }).success).toBe(
      false,
    );
    expect(TeleconsultationSettings.safeParse({ ...base, recording: true }).success).toBe(false);
  });
});
