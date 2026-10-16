import { z } from 'zod';

/**
 * Typed catalogue of audit actions. The writer accepts only these strings, so a typo cannot create
 * a new, unqueryable action. Families follow the mandatory events of the audit-log spec.
 */
export const AUDIT_ACTIONS = [
  // Authentication (including patient portal sign-ins by one-time code).
  'auth.login.success',
  'auth.login.failed',
  'auth.login.locked',
  'auth.account.locked',
  'auth.account.unlocked',
  'auth.logout',
  'auth.session.revoked',
  'auth.password.changed',
  'auth.password.reset_requested',
  'auth.password.reset_completed',
  'auth.2fa.enrolled',
  'auth.2fa.verified',
  'auth.2fa.failed',
  'auth.2fa.recovery_used',
  'auth.2fa.recovery_regenerated',
  'auth.2fa.disabled',
  'auth.invitation.accepted',
  'auth.portal.sign_in',
  // Clinical records (every read and write).
  'clinical.note.read',
  'clinical.note.created',
  'clinical.note.updated',
  'clinical.note.signed',
  'clinical.note.amended',
  'clinical.note.entered_in_error',
  'clinical.anamnesis.read',
  'clinical.anamnesis.updated',
  'clinical.search',
  // Patient identity data.
  'patient.created',
  'patient.updated',
  'patient.read',
  'patient.bulk_read',
  'patient.deactivated',
  'patient.reactivated',
  'patient.representative.changed',
  'patient.coverage.changed',
  'patient.consent.recorded',
  'patient.consent.revoked',
  'patient.rights_request.created',
  'patient.rights_request.fulfilled',
  // Access control changes.
  'role.changed',
  'permission.granted',
  'permission.revoked',
  'location_membership.changed',
  'sharing.changed',
  'assignment.created',
  'assignment.removed',
  'matricula.verified',
  'setting.reception_sees_clinical_metadata.changed',
  // Branding: the identity of the organization and its logo.
  'branding.updated',
  'branding.logo_updated',
  // Other organization settings (two-factor policy, quiet hours): the entry names the setting.
  'setting.changed',
  // Locations of the organization.
  'location.created',
  'location.updated',
  'location.deactivated',
  'location.reactivated',
  // Staff lifecycle.
  'staff.invited',
  'staff.deactivated',
  'staff.reactivated',
  'staff.profile_updated',
  'professional.hours_updated',
  // Exports and archive.
  'export.created',
  'archive.read',
  'audit.exported',
  // Platform operator.
  'support.access',
  'tenant.created',
  'tenant.demo_reset',
  // Denials.
  'access.denied',
  'cross_tenant.denied',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: string): value is AuditAction {
  return AUDIT_ACTIONS.some((action) => action === value);
}

export const AUDIT_OUTCOMES = ['allow', 'deny'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * Metadata keys that must never appear in an audit entry: clinical content and secrets. The log
 * records who touched what and when; it never holds what was written (audit-log, "Entry content").
 * Comparison ignores case and underscores.
 */
export const FORBIDDEN_METADATA_KEYS = [
  'content',
  'note',
  'notes',
  'text',
  'body',
  'diagnosis',
  'anamnesis',
  'symptoms',
  'treatment',
  'prescription',
  'password',
  'passwordHash',
  'token',
  'secret',
  'totp',
  'otp',
  'recoveryCode',
  'cookie',
  'authorization',
  'apiKey',
] as const;

const FORBIDDEN = new Set(
  FORBIDDEN_METADATA_KEYS.map((key) => key.toLowerCase().replaceAll('_', '')),
);

const MAX_KEYS = 20;
const MAX_STRING = 200;

const scalar = z.union([z.string().max(MAX_STRING), z.number(), z.boolean(), z.null()]);

/**
 * Metadata of an audit entry: a flat object of scalars and short lists of scalars. No nesting (a
 * nested object would hide a forbidden key), no long free text, at most 20 keys.
 */
export const AuditMetadata = z
  .record(z.string(), z.union([scalar, z.array(scalar).max(50)]))
  .superRefine((metadata, ctx) => {
    const keys = Object.keys(metadata);
    if (keys.length > MAX_KEYS) {
      ctx.addIssue({ code: 'custom', message: `at most ${String(MAX_KEYS)} keys` });
    }
    for (const key of keys) {
      if (FORBIDDEN.has(key.toLowerCase().replaceAll('_', ''))) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'key is not allowed in audit metadata',
        });
      }
    }
  });
export type AuditMetadata = z.infer<typeof AuditMetadata>;
