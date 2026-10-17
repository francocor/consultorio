import { describe, expect, it } from 'vitest';

import { TOKEN_KINDS, TOKEN_KIND_REGISTRY, isEnabledKind } from './kinds.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('action token kinds (design 4.5)', () => {
  it('lists the canonical kinds', () => {
    expect([...TOKEN_KINDS].sort()).toEqual(
      [
        'appointment_cancel',
        'appointment_confirm',
        'appointment_reschedule',
        'archive_release',
        'document_download',
        'notification_opt_out',
        'password_reset',
        'portal_activation',
        'signup_verification',
        'staff_invitation',
        'video_join',
        'waitlist_offer',
        'whatsapp_opt_in',
      ].sort(),
    );
  });

  it('enables the account flows, the document download and the booking self-service link for now', () => {
    const enabled = TOKEN_KINDS.filter((kind) => isEnabledKind(kind)).sort();

    expect(enabled).toEqual(
      [
        'appointment_reschedule',
        'document_download',
        'password_reset',
        'portal_activation',
        'signup_verification',
        'staff_invitation',
      ].sort(),
    );
  });

  it('gives a password reset 30 minutes and a single use', () => {
    expect(TOKEN_KIND_REGISTRY.password_reset).toMatchObject({
      ttlMs: 30 * MINUTE,
      maxUses: 1,
      sessionBound: false,
    });
  });

  it('keeps invitations and activations short-lived and single use', () => {
    for (const kind of ['staff_invitation', 'portal_activation', 'signup_verification'] as const) {
      expect(TOKEN_KIND_REGISTRY[kind].maxUses).toBe(1);
      expect(TOKEN_KIND_REGISTRY[kind].ttlMs).toBeLessThanOrEqual(7 * 24 * HOUR);
    }
  });

  it('binds a document download to a session, for five minutes, once', () => {
    expect(TOKEN_KIND_REGISTRY.document_download).toMatchObject({
      ttlMs: 5 * MINUTE,
      maxUses: 1,
      sessionBound: true,
    });
  });

  it('gives every kind a positive lifetime and use count', () => {
    for (const kind of TOKEN_KINDS) {
      expect(TOKEN_KIND_REGISTRY[kind].ttlMs, kind).toBeGreaterThan(0);
      expect(TOKEN_KIND_REGISTRY[kind].maxUses, kind).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps the booking link alive for as long as a booking can be made ahead (a year)', () => {
    expect(TOKEN_KIND_REGISTRY.appointment_reschedule).toMatchObject({
      ttlMs: 366 * 24 * HOUR,
      maxUses: 1,
      sessionBound: false,
    });
  });
});
