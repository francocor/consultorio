import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTIONS,
  AUDIT_OUTCOMES,
  AuditMetadata,
  FORBIDDEN_METADATA_KEYS,
  isAuditAction,
} from './audit-actions.js';
import { ARCHIVE_PLATFORM_AUDIT_ACTIONS } from './cancellation-catalog.js';

describe('audit action catalogue', () => {
  it('lists unique, dot-separated lowercase actions', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    for (const action of AUDIT_ACTIONS) {
      expect(action, action).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
    }
  });

  it('covers the mandatory event families of the audit-log spec', () => {
    // Archive access is written in the platform trail (the organization is gone), not in the tenant
    // one: `archive.accessed`, `archive.released`, ...
    const families = new Set(
      [...AUDIT_ACTIONS, ...ARCHIVE_PLATFORM_AUDIT_ACTIONS].map((action) => action.split('.')[0]),
    );

    for (const family of [
      'auth',
      'clinical',
      'patient',
      'role',
      'permission',
      'location_membership',
      'sharing',
      'assignment',
      'matricula',
      'setting',
      'export',
      'archive',
      'support',
      'access',
      'tenant',
    ]) {
      expect(families.has(family), family).toBe(true);
    }
  });

  it('recognizes catalogued actions only', () => {
    expect(isAuditAction('auth.login.success')).toBe(true);
    expect(isAuditAction('clinical.note.read')).toBe(true);
    expect(isAuditAction('made.up.action')).toBe(false);
    expect(isAuditAction('')).toBe(false);
  });

  it('has the two outcomes allow and deny', () => {
    expect([...AUDIT_OUTCOMES]).toEqual(['allow', 'deny']);
  });
});

describe('audit metadata schema', () => {
  it('accepts field names, versions, roles and counts', () => {
    const metadata = {
      changedFields: ['phone', 'email'],
      version: 3,
      fromRole: 'reception',
      toRole: 'admin',
      count: 12,
      shared: true,
    };

    const parsed = AuditMetadata.parse(metadata);

    expect(parsed).toMatchObject({ changedFields: ['phone', 'email'], version: 3 });
  });

  it.each(FORBIDDEN_METADATA_KEYS)('rejects the clinical or secret key %s', (key) => {
    expect(AuditMetadata.safeParse({ [key]: 'x' }).success).toBe(false);
    expect(AuditMetadata.safeParse({ [key.toUpperCase()]: 'x' }).success).toBe(false);
  });

  it('rejects a forbidden key even when its value is empty or nested', () => {
    expect(AuditMetadata.safeParse({ content: '' }).success).toBe(false);
    expect(AuditMetadata.safeParse({ detail: { content: 'x' } }).success).toBe(false);
  });

  it('rejects nested objects and long free text (metadata is not a place for prose)', () => {
    expect(AuditMetadata.safeParse({ detail: { a: 1 } }).success).toBe(false);
    expect(AuditMetadata.safeParse({ comment: 'x'.repeat(201) }).success).toBe(false);
    expect(AuditMetadata.safeParse({ comment: 'x'.repeat(200) }).success).toBe(true);
  });

  it('accepts an empty object', () => {
    expect(AuditMetadata.parse({})).toEqual({});
  });

  it('rejects more than 20 keys', () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${String(i)}`, 1]));

    expect(AuditMetadata.safeParse(many).success).toBe(false);
  });
});

describe('Stage 3 audit actions', () => {
  const stage3 = [
    'notification.optout.recorded',
    'notification.optin.recorded',
    'notification.resend',
    'notification.integration.changed',
    'booking.link.enabled',
    'booking.link.disabled',
    'booking.link.regenerated',
    'booking.online.created',
    'booking.suspicious',
    'waitlist.entry.created',
    'waitlist.entry.updated',
    'waitlist.entry.closed',
    'waitlist.offer.created',
    'waitlist.offer.accepted',
    'waitlist.offer.declined',
    'waitlist.offer.expired',
    'waitlist.priority.overridden',
    'video.link.created',
    'video.link.opened',
    'video.link.revoked',
    'video.link.joined',
    'video.link.manual_attached',
  ];

  it('are all catalogued, once each', () => {
    for (const action of stage3) {
      expect(isAuditAction(action), action).toBe(true);
      expect(
        AUDIT_ACTIONS.filter((known) => known === action),
        action,
      ).toHaveLength(1);
    }
  });

  it('still reject the clinical and secret keys a message or a link could tempt someone to log', () => {
    for (const key of ['body', 'text', 'token', 'otp', 'content']) {
      expect(AuditMetadata.safeParse({ channel: 'whatsapp', [key]: 'x' }).success, key).toBe(false);
    }
    expect(AuditMetadata.safeParse({ channel: 'whatsapp', status: 'sent' }).success).toBe(true);
  });
});

describe('Stage 4 audit actions (revenue)', () => {
  const stage4 = [
    'billing.price.changed',
    'billing.price.override',
    'charge.captured',
    'charge.voided',
    'charge.flagged',
    'payment.recorded',
    'payment.override',
    'payment.refunded',
    'cash.opened',
    'cash.closed',
    'cash.adjusted',
    'export.requested',
    'invoice.requested',
    'invoice.issued',
    'invoice.rejected',
    'invoice.retried',
    'invoice.manual',
    'invoice.credit_note',
    'invoicing.config.changed',
    'invoicing.credential.changed',
    'report.accessed',
  ];

  it('are all catalogued, once each', () => {
    for (const action of stage4) {
      expect(isAuditAction(action), action).toBe(true);
      expect(
        AUDIT_ACTIONS.filter((known) => known === action),
        action,
      ).toHaveLength(1);
    }
  });

  it('accept the amounts and states a money entry carries', () => {
    expect(
      AuditMetadata.safeParse({ amountCents: 350000, method: 'cash', status: 'paid' }).success,
    ).toBe(true);
  });

  it('refuse the card data, certificates and keys that money and fiscal entries could tempt someone to log', () => {
    for (const key of ['cardNumber', 'cvv', 'pan', 'certificate', 'privateKey', 'pem', 'apiKey']) {
      expect(AuditMetadata.safeParse({ amountCents: 1, [key]: 'x' }).success, key).toBe(false);
    }
    // Case and underscores do not hide a key.
    expect(AuditMetadata.safeParse({ card_number: 'x' }).success).toBe(false);
    expect(AuditMetadata.safeParse({ PRIVATE_KEY: 'x' }).success).toBe(false);
  });
});

describe('Stage 5 audit actions (consent, e-prescription, portal)', () => {
  const stage5 = [
    'consent.template.created',
    'consent.template.published',
    'consent.template.retired',
    'consent.requested',
    'consent.signed',
    'consent.revoked',
    'consent.read',
    'consent.expired',
    'prescription.issued',
    'prescription.cancelled',
    'prescription.read',
    'prescription.downloaded',
    'prescription.failed',
    'prescription.registered_manually',
    'portal.identity.created',
    'portal.identity.linked',
    'portal.identity.deactivated',
    'portal.signin.success',
    'portal.signin.failure',
    'portal.read',
    'portal.download',
    'portal.profile.changed',
    'portal.denied',
  ];

  it('are all catalogued, once each', () => {
    for (const action of stage5) {
      expect(isAuditAction(action), action).toBe(true);
      expect(
        AUDIT_ACTIONS.filter((known) => known === action),
        action,
      ).toHaveLength(1);
    }
  });

  it('accept the identifiers and states a consent, a prescription or a portal entry carries', () => {
    expect(
      AuditMetadata.safeParse({ templateVersion: 3, method: 'in_person', status: 'signed' })
        .success,
    ).toBe(true);
    expect(
      AuditMetadata.safeParse({ section: 'prescriptions', outcome: 'allow', count: 2 }).success,
    ).toBe(true);
  });

  it('refuse the medications, signatures and evidence a prescription or a consent could tempt someone to log', () => {
    for (const key of [
      'prescription',
      'items',
      'medication',
      'medications',
      'signature',
      'evidence',
      'content',
      'otp',
    ]) {
      expect(AuditMetadata.safeParse({ status: 'issued', [key]: 'x' }).success, key).toBe(false);
    }
    // Case and underscores do not hide a key, and a plain count of lines is fine.
    expect(AuditMetadata.safeParse({ Medi_cations: 'x' }).success).toBe(false);
    expect(AuditMetadata.safeParse({ itemCount: 3, status: 'issued' }).success).toBe(true);
  });
});

describe('Stage 6 audit actions (subscriptions, signup, cancellation)', () => {
  const stage6 = [
    'subscription.created',
    'subscription.plan_changed',
    'subscription.state_changed',
    'subscription.cap_changed',
    'subscription.surplus_flagged',
    'subscription.refunded',
    'signup.created',
    'signup.verified',
    'terms.accepted',
    'tenant.cancelled',
    'export.cancellation.requested',
    'export.cancellation.downloaded',
    'export.cancellation.removed',
  ];

  it('are all catalogued, once each', () => {
    for (const action of stage6) {
      expect(isAuditAction(action), action).toBe(true);
      expect(
        AUDIT_ACTIONS.filter((known) => known === action),
        action,
      ).toHaveLength(1);
    }
  });

  it('keep the archive and the purge of a signup out of the tenant trail: they belong to the platform', () => {
    for (const action of [
      'signup.purged',
      'archive.written',
      'archive.verified',
      'archive.accessed',
      'archive.released',
      'archive.erased',
    ]) {
      expect(isAuditAction(action), action).toBe(false);
    }
  });

  it('accept the identifiers and states a subscription entry carries, and refuse card data', () => {
    expect(
      AuditMetadata.safeParse({
        fromStatus: 'trial',
        toStatus: 'past_due',
        planId: 'plan-pro',
        professionals: 2,
        providerEventId: '424242',
        overageCapMessages: 300,
      }).success,
    ).toBe(true);
    for (const key of ['cardNumber', 'cvv', 'pan', 'token', 'secret']) {
      expect(AuditMetadata.safeParse({ planId: 'plan-pro', [key]: 'x' }).success, key).toBe(false);
    }
  });
});
