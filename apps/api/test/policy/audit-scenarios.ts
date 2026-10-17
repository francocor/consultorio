import type { AuditAction } from '@consultorio/contracts';

/**
 * Where each audit action is proven. Every action of the catalogue has an entry here (the type
 * makes a missing one a compile error), and the policy test `audit-coverage.test.ts` checks the
 * entry is true: a `test` file exists and names the action, and a `pending` reason points at the
 * stage that will write the event.
 *
 * Adding an action to `AUDIT_ACTIONS` therefore forces whoever adds it to say which test proves it.
 */
export type AuditScenario = { test: string } | { pending: string };

const t = (file: string): AuditScenario => ({ test: `apps/api/test/integration/${file}` });

export const AUDIT_SCENARIOS: Record<AuditAction, AuditScenario> = {
  // Authentication.
  'auth.login.success': t('auth-routes.test.ts'),
  'auth.login.failed': t('auth-routes.test.ts'),
  'auth.login.locked': t('lockout.test.ts'),
  'auth.account.locked': t('lockout.test.ts'),
  'auth.account.unlocked': t('lockout.test.ts'),
  'auth.logout': t('auth-routes.test.ts'),
  'auth.session.revoked': t('auth-routes.test.ts'),
  'auth.password.changed': {
    pending: 'Stage 1 web (S1.31): the change-password screen of a signed-in user',
  },
  'auth.password.reset_requested': t('password-reset.test.ts'),
  'auth.password.reset_completed': t('password-reset.test.ts'),
  'auth.2fa.enrolled': t('two-factor-routes.test.ts'),
  'auth.2fa.verified': t('two-factor-routes.test.ts'),
  'auth.2fa.failed': t('two-factor-routes.test.ts'),
  'auth.2fa.recovery_used': t('two-factor-routes.test.ts'),
  'auth.2fa.recovery_regenerated': t('two-factor-routes.test.ts'),
  'auth.2fa.disabled': t('two-factor-routes.test.ts'),
  'auth.invitation.accepted': t('invitation-accept.test.ts'),
  'auth.portal.sign_in': { pending: 'Stage 5: patient portal sign-in by one-time code' },

  // Clinical records.
  'clinical.note.read': { pending: 'Stage 2 (S2.17 to S2.21): clinical notes' },
  'clinical.note.created': { pending: 'Stage 2 (S2.18): draft and sign' },
  'clinical.note.updated': { pending: 'Stage 2 (S2.18): draft and sign' },
  'clinical.note.signed': { pending: 'Stage 2 (S2.18): draft and sign' },
  'clinical.note.amended': { pending: 'Stage 2 (S2.19): addenda' },
  'clinical.note.entered_in_error': { pending: 'Stage 2 (S2.19): entered in error' },
  'clinical.anamnesis.read': t('anamnesis-api.test.ts'),
  'clinical.anamnesis.updated': t('anamnesis-api.test.ts'),
  'clinical.search': { pending: 'Stage 2 (S2.21): per-patient clinical search' },

  // Patient identity data.
  'patient.created': t('patients-api.test.ts'),
  'patient.updated': t('patients-api.test.ts'),
  'patient.read': t('patients-api.test.ts'),
  'patient.bulk_read': {
    pending: 'Stage 6: export of patient identity data (cancellation export)',
  },
  'patient.deactivated': t('patients-api.test.ts'),
  'patient.reactivated': t('patients-api.test.ts'),
  'patient.representative.changed': t('patients-minors.test.ts'),
  'patient.coverage.changed': t('patients-coverage.test.ts'),
  'patient.consent.recorded': t('patients-consent.test.ts'),
  'patient.consent.revoked': t('patients-consent.test.ts'),
  'patient.rights_request.created': t('patients-rights.test.ts'),
  'patient.rights_request.fulfilled': t('patients-rights.test.ts'),

  // Access control changes.
  'role.changed': t('access-grants.test.ts'),
  'permission.granted': t('access-grants.test.ts'),
  'permission.revoked': t('access-grants.test.ts'),
  'location_membership.changed': t('access-locations.test.ts'),
  'sharing.changed': t('access-settings.test.ts'),
  'assignment.created': t('care-assignment-api.test.ts'),
  'assignment.removed': t('care-assignment-api.test.ts'),
  'assignment.review_flag': t('care-assignment-api.test.ts'),
  'matricula.verified': { pending: 'Stage 5: matricula verification in the operator console' },
  'setting.reception_sees_clinical_metadata.changed': t('access-settings.test.ts'),
  'setting.changed': t('access-settings.test.ts'),
  'branding.updated': t('branding-api.test.ts'),
  'branding.logo_updated': t('branding-logo.test.ts'),
  'location.created': t('access-locations.test.ts'),
  'location.updated': t('access-locations.test.ts'),
  'location.deactivated': t('access-locations.test.ts'),
  'location.reactivated': t('access-locations.test.ts'),

  // Staff lifecycle.
  'staff.invited': t('staff-lifecycle.test.ts'),
  'staff.deactivated': t('staff-lifecycle.test.ts'),
  'staff.reactivated': t('staff-lifecycle.test.ts'),
  'staff.profile_updated': t('staff-profile.test.ts'),
  'professional.hours_updated': t('staff-hours.test.ts'),

  // Exports and archive.
  'export.created': { pending: 'Stage 6: cancellation export' },
  'archive.read': { pending: 'Stage 6: archive access' },
  'audit.exported': t('audit-viewer.test.ts'),

  // Platform operator.
  'support.access': t('operator-support.test.ts'),
  'support.grant.created': t('operator-support.test.ts'),
  'support.grant.revoked': t('operator-support.test.ts'),
  'tenant.created': t('operator-tenants.test.ts'),
  'tenant.demo_reset': { pending: 'S1.36 (task 1.124): demo reset' },

  // Denials.
  'access.denied': t('admin-denied.test.ts'),
  'cross_tenant.denied': {
    pending:
      'S1.37 (gate): a cookie replayed on another tenant finds no session and is answered 401, so there is nothing to attribute yet',
  },
};
