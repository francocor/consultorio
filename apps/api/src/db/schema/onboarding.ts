import { sql } from 'drizzle-orm';
import { check, foreignKey, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { tenant } from './tenant.js';

/** Free-form JSON object columns. Their shapes are validated in the API. */
type JsonObject = Record<string, unknown>;

const WIZARD_STEPS_SQL = `('profile', 'location', 'hours', 'appointment_types', 'team', 'branding', 'billing')`;

/**
 * Where an organization is in its guided first run (tenant-onboarding, Part A). One row per
 * organization: the progress belongs to the organization, not to the person who happens to be
 * signed in, so a second owner (or the same owner on a phone) resumes where the first one stopped.
 *
 * - `step_progress` maps a wizard step to `done` or `skipped`; a step missing from it is pending.
 * - `answers` keeps what the owner answered (for example "I am a health professional"), so the
 *   wizard resumes with the previous answers. It holds no patient data and no free text.
 * - The wizard is finished when `wizard_completed_at` is set; the service refuses to set it while
 *   a required piece (location, a professional with hours, an appointment type) is missing.
 * - The checklist is dismissed when `checklist_dismissed_at` is set; it stays reachable from Help.
 *
 * A row is never deleted: finishing and dismissing are recorded with their author, and bringing the
 * checklist back clears the dismissal.
 */
export const onboardingState = tenantTable(
  'onboarding_state',
  {
    stepProgress: jsonb('step_progress').$type<JsonObject>().notNull().default({}),
    currentStep: text('current_step'),
    answers: jsonb('answers').$type<JsonObject>().notNull().default({}),
    wizardCompletedAt: timestamp('wizard_completed_at', { withTimezone: true }),
    wizardCompletedBy: uuid('wizard_completed_by'),
    checklistDismissedAt: timestamp('checklist_dismissed_at', { withTimezone: true }),
    checklistDismissedBy: uuid('checklist_dismissed_by'),
  },
  (table) => [
    foreignKey({
      name: 'onboarding_state_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    uniqueIndex('onboarding_state_tenant_key').on(table.tenantId),
    check(
      'onboarding_state_current_step_check',
      sql`${table.currentStep} is null or ${table.currentStep} in ${sql.raw(WIZARD_STEPS_SQL)}`,
    ),
    check(
      'onboarding_state_completed_check',
      sql`(${table.wizardCompletedAt} is null) = (${table.wizardCompletedBy} is null)`,
    ),
    check(
      'onboarding_state_dismissed_check',
      sql`(${table.checklistDismissedAt} is null) = (${table.checklistDismissedBy} is null)`,
    ),
  ],
);

export type OnboardingStateRow = typeof onboardingState.$inferSelect;
