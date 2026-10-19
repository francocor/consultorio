import type {
  AuditAction,
  BILLING_AUDIT_ACTIONS,
  CONSENT_AUDIT_ACTIONS,
  INVOICING_AUDIT_ACTIONS,
  NOTIFICATION_AUDIT_ACTIONS,
  ONLINE_BOOKING_AUDIT_ACTIONS,
  PORTAL_AUDIT_ACTIONS,
  PRESCRIPTION_AUDIT_ACTIONS,
  REPORTS_AUDIT_ACTIONS,
  TELECONSULTATION_AUDIT_ACTIONS,
  WAITLIST_AUDIT_ACTIONS,
} from '@consultorio/contracts';

import { BILLING_SCENARIOS } from './audit-scenarios/billing.js';
import { CONSENT_SCENARIOS } from './audit-scenarios/consent.js';
import { INVOICING_SCENARIOS } from './audit-scenarios/invoicing.js';
import { NOTIFICATION_SCENARIOS } from './audit-scenarios/notifications.js';
import { ONLINE_BOOKING_SCENARIOS } from './audit-scenarios/online-booking.js';
import { PORTAL_SCENARIOS } from './audit-scenarios/portal.js';
import { PRESCRIPTION_SCENARIOS } from './audit-scenarios/prescriptions.js';
import { REPORTS_SCENARIOS } from './audit-scenarios/reports.js';
import { TELECONSULTATION_SCENARIOS } from './audit-scenarios/teleconsultation.js';
import { WAITLIST_SCENARIOS } from './audit-scenarios/waitlist.js';

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

/**
 * The actions each capability module declares next to its contracts. Their scenarios live in
 * `audit-scenarios/<module>.ts`, so a track proves its actions without editing this file.
 */
type ModuleAuditAction =
  | (typeof NOTIFICATION_AUDIT_ACTIONS)[number]
  | (typeof ONLINE_BOOKING_AUDIT_ACTIONS)[number]
  | (typeof WAITLIST_AUDIT_ACTIONS)[number]
  | (typeof TELECONSULTATION_AUDIT_ACTIONS)[number]
  | (typeof BILLING_AUDIT_ACTIONS)[number]
  | (typeof REPORTS_AUDIT_ACTIONS)[number]
  | (typeof INVOICING_AUDIT_ACTIONS)[number]
  | (typeof CONSENT_AUDIT_ACTIONS)[number]
  | (typeof PRESCRIPTION_AUDIT_ACTIONS)[number]
  | (typeof PORTAL_AUDIT_ACTIONS)[number];

const PLATFORM_SCENARIOS: Record<Exclude<AuditAction, ModuleAuditAction>, AuditScenario> = {
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
  'clinical.note.read': t('clinical-notes-api.test.ts'),
  'clinical.note.created': t('clinical-notes-api.test.ts'),
  'clinical.note.updated': t('clinical-notes-api.test.ts'),
  'clinical.note.signed': t('clinical-notes-api.test.ts'),
  'clinical.note.amended': t('clinical-addenda.test.ts'),
  'clinical.note.entered_in_error': t('clinical-addenda.test.ts'),
  'clinical.anamnesis.read': t('anamnesis-api.test.ts'),
  'clinical.anamnesis.updated': t('anamnesis-api.test.ts'),
  'clinical.search': t('clinical-search.test.ts'),

  // Documents.
  'document.uploaded': t('documents-uploads.test.ts'),
  'document.scanned': t('documents-scan.test.ts'),
  'document.downloaded': t('documents-download.test.ts'),
  'document.hidden': t('documents-lifecycle.test.ts'),
  'document.reclassified': t('documents-access.test.ts'),

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
  'professional.added_by_admin': t('professional-added-by-admin.test.ts'),
  'professional.hours_updated': t('staff-hours.test.ts'),
  'professional.hours_period_set': t('scheduling-config-api.test.ts'),
  'professional.hours_period_removed': t('scheduling-config-api.test.ts'),

  // Appointments.
  'appointment.created': t('scheduling-booking.test.ts'),
  'appointment.overridden': t('scheduling-booking.test.ts'),
  'appointment.rescheduled': t('scheduling-lifecycle.test.ts'),
  'appointment.reassigned': t('scheduling-lifecycle.test.ts'),
  'appointment.status_changed': t('scheduling-lifecycle.test.ts'),
  'appointment.cancelled': t('scheduling-lifecycle.test.ts'),
  'appointment.status_corrected': t('scheduling-lifecycle.test.ts'),
  'appointment.calendar_viewed': t('scheduling-calendar.test.ts'),
  'appointment.identity.confirmed': t('scheduling-identity.test.ts'),
  'appointment.identity.self_confirmed': t('scheduling-identity.test.ts'),
  'appointment.identity.rejected': t('scheduling-identity.test.ts'),
  'worklist.resolved': t('scheduling-worklist.test.ts'),
  'worklist.dismissed': t('scheduling-worklist.test.ts'),

  // Scheduling setup.
  'appointment_type.created': t('scheduling-config-api.test.ts'),
  'appointment_type.updated': t('scheduling-config-api.test.ts'),
  'appointment_type.deactivated': t('scheduling-config-api.test.ts'),
  'appointment_type.reactivated': t('scheduling-config-api.test.ts'),
  'schedule_block.created': t('scheduling-config-api.test.ts'),
  'schedule_block.removed': t('scheduling-config-api.test.ts'),
  'day_off.created': t('scheduling-config-api.test.ts'),
  'day_off.removed': t('scheduling-config-api.test.ts'),

  // Exports and archive.
  'export.created': { pending: 'Stage 6: cancellation export' },
  'archive.read': { pending: 'Stage 6: archive access' },
  'audit.exported': t('audit-viewer.test.ts'),

  // The guided first run.
  'onboarding.step_updated': t('onboarding-api.test.ts'),
  'onboarding.completed': t('onboarding-api.test.ts'),
  'onboarding.fast_path': t('onboarding-api.test.ts'),
  'onboarding.checklist_dismissed': t('onboarding-api.test.ts'),
  'onboarding.checklist_restored': t('onboarding-api.test.ts'),

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

export const AUDIT_SCENARIOS: Record<AuditAction, AuditScenario> = {
  ...PLATFORM_SCENARIOS,
  ...NOTIFICATION_SCENARIOS,
  ...ONLINE_BOOKING_SCENARIOS,
  ...WAITLIST_SCENARIOS,
  ...TELECONSULTATION_SCENARIOS,
  ...BILLING_SCENARIOS,
  ...REPORTS_SCENARIOS,
  ...INVOICING_SCENARIOS,
  ...CONSENT_SCENARIOS,
  ...PRESCRIPTION_SCENARIOS,
  ...PORTAL_SCENARIOS,
};
