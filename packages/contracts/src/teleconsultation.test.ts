import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS } from './audit-actions.js';
import {
  DEFAULT_TELECONSULTATION_SETTINGS,
  ManualVideoLinkRequest,
  TELECONSULTATION_AUDIT_ACTIONS,
  TELECONSULTATION_ERRORS,
  TeleconsultationSettings,
  VIDEO_CLOSE_REASONS,
  VIDEO_JOIN_CLOSES_AFTER_END_MINUTES,
  VIDEO_PENDING_REASONS,
  VIDEO_SESSION_STATUSES,
  VideoSessionSummary,
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

describe('video session vocabulary', () => {
  it('says why a link is pending and why a session closed', () => {
    expect([...VIDEO_PENDING_REASONS]).toEqual([
      'creating',
      'integration_off',
      'provider_unavailable',
      'provider_failed',
    ]);
    expect([...VIDEO_CLOSE_REASONS]).toEqual(['cancelled', 'no_show', 'attended', 'in_person']);
  });

  it('keeps the join window rule of the spec: 60 minutes after the scheduled end', () => {
    expect(VIDEO_JOIN_CLOSES_AFTER_END_MINUTES).toBe(60);
  });
});

describe('teleconsultation error catalogue', () => {
  it('declares each code with a status and the key of its es-AR message', () => {
    expect(Object.keys(TELECONSULTATION_ERRORS).sort()).toEqual([
      'video_link_unavailable',
      'video_no_show_too_early',
      'video_not_virtual',
      'video_outside_window',
    ]);
    for (const [code, entry] of Object.entries(TELECONSULTATION_ERRORS)) {
      expect(entry.i18nKey).toBe(`errors.${code}`);
      expect(entry.status).toBe(409);
    }
  });
});

describe('manual video link request', () => {
  it('takes one address and nothing else', () => {
    expect(ManualVideoLinkRequest.parse({ url: 'https://meet.example.org/abc' })).toEqual({
      url: 'https://meet.example.org/abc',
    });
    expect(ManualVideoLinkRequest.safeParse({ url: '' }).success).toBe(false);
    expect(ManualVideoLinkRequest.safeParse({ url: 'x'.repeat(2049) }).success).toBe(false);
    expect(ManualVideoLinkRequest.safeParse({ url: 'https://a.example', extra: 1 }).success).toBe(
      false,
    );
  });
});

describe('video session summary', () => {
  const base = {
    virtual: true,
    status: 'ready',
    pendingReason: null,
    hasLink: true,
    manual: false,
    patientOpenedLink: false,
    firstOpenedAt: null,
    integrationEnabled: true,
    window: { opensAt: '2031-05-12T12:45:00.000Z', closesAt: '2031-05-12T14:30:00.000Z' },
    canJoin: false,
    canAttachManualLink: true,
    noShowAllowedFrom: '2031-05-12T13:15:00.000Z',
  } as const;

  it('describes a virtual appointment without ever carrying an address', () => {
    expect(VideoSessionSummary.parse(base)).toEqual(base);
    expect(VideoSessionSummary.safeParse({ ...base, url: 'https://x.example' }).success).toBe(
      false,
    );
  });

  it('describes an in person appointment as not virtual', () => {
    const inPerson = {
      ...base,
      virtual: false,
      status: null,
      hasLink: false,
      window: null,
      noShowAllowedFrom: null,
      canAttachManualLink: false,
    };
    expect(VideoSessionSummary.parse(inPerson).virtual).toBe(false);
  });
});
