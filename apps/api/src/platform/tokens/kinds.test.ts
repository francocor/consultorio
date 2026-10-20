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
        'cancellation_export',
        'document_download',
        'export_download',
        'invoice_pdf',
        'notification_opt_out',
        'password_reset',
        'portal_activation',
        'prescription_pdf',
        'signup_verification',
        'staff_invitation',
        'video_join',
        'waitlist_offer',
        'whatsapp_opt_in',
      ].sort(),
    );
  });

  it('enables the account flows and the document download, and only the kinds a capability has turned on', () => {
    const enabled = TOKEN_KINDS.filter((kind) => isEnabledKind(kind)).sort();
    const fromStageOne = [
      'document_download',
      'password_reset',
      'portal_activation',
      'signup_verification',
      'staff_invitation',
    ];
    // Each Stage 3 track turns on its own kinds and nothing else.
    const fromStageThree = [
      'appointment_cancel',
      'appointment_confirm',
      'appointment_reschedule',
      'notification_opt_out',
      'video_join',
      'waitlist_offer',
      'whatsapp_opt_in',
    ];

    // Stage 4 turned on the export link (billing, track A) and the invoice PDF link (invoicing, track C).
    const fromStageFour = ['export_download', 'invoice_pdf'];

    // Stage 5 turned on the PDF link of a prescription (e-prescription track).
    const fromStageFive = ['prescription_pdf'];

    // Stage 6 turned on the link of a package of the cancellation export (retention track).
    const fromStageSix = ['cancellation_export'];

    expect(enabled).toEqual(expect.arrayContaining(fromStageOne));
    expect(
      enabled.filter(
        (kind) =>
          !fromStageOne.includes(kind) &&
          !fromStageThree.includes(kind) &&
          !fromStageFour.includes(kind) &&
          !fromStageFive.includes(kind) &&
          !fromStageSix.includes(kind),
      ),
    ).toEqual([]);
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

  it('lets a video join link live as long as the longest reminder lead time needs', () => {
    // Reminders go out up to 14 days ahead (the contracts cap), and the link stays known 12 hours
    // after the join window, which closes an hour after the end of the appointment.
    const longestLead = 14 * 24 * HOUR;
    const afterTheStart = 12 * HOUR + 8 * HOUR + HOUR;

    expect(TOKEN_KIND_REGISTRY.video_join.ttlMs).toBe(15 * 24 * HOUR);
    expect(TOKEN_KIND_REGISTRY.video_join.ttlMs).toBeGreaterThanOrEqual(
      longestLead + afterTheStart,
    );
  });

  it('binds a document download to a session, for five minutes, once', () => {
    expect(TOKEN_KIND_REGISTRY.document_download).toMatchObject({
      ttlMs: 5 * MINUTE,
      maxUses: 1,
      sessionBound: true,
    });
  });

  it('binds an export download and an invoice PDF to a session like a document; each track turns its own on', () => {
    for (const kind of [
      'export_download',
      'invoice_pdf',
      'prescription_pdf',
      'cancellation_export',
    ] as const) {
      expect(TOKEN_KIND_REGISTRY[kind], kind).toMatchObject({
        ttlMs: 5 * MINUTE,
        maxUses: 1,
        sessionBound: true,
      });
    }
    // Billing (S4.05) turned the export link on, invoicing (S4.12) the invoice PDF link.
    expect(TOKEN_KIND_REGISTRY.export_download.enabled).toBe(true);
    expect(TOKEN_KIND_REGISTRY.invoice_pdf.enabled).toBe(true);
    // E-prescription (S5.04) turned on the prescription PDF link.
    expect(TOKEN_KIND_REGISTRY.prescription_pdf.enabled).toBe(true);
    // The seam of Stage 6 turned on the package link; the retention track (S6.34) registers its resource.
    expect(TOKEN_KIND_REGISTRY.cancellation_export.enabled).toBe(true);
    // The break-glass release stays off until its operator routes exist (task 6.41).
    expect(TOKEN_KIND_REGISTRY.archive_release.enabled).toBe(false);
  });

  it('gives every kind a positive lifetime and use count', () => {
    for (const kind of TOKEN_KINDS) {
      expect(TOKEN_KIND_REGISTRY[kind].ttlMs, kind).toBeGreaterThan(0);
      expect(TOKEN_KIND_REGISTRY[kind].maxUses, kind).toBeGreaterThanOrEqual(1);
    }
  });
});
