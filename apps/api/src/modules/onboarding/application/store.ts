import { WIZARD_STEPS, WizardAnswers, type WizardStep } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';

import { onboardingState, type OnboardingStateRow } from '../../../db/schema/onboarding.js';
import { tenant } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { WizardRecord } from '../domain/wizard.js';

/** The saved progress of the organization, or the empty one when nothing was saved yet. */
export interface StoredState extends WizardRecord {
  checklistDismissedAt: Date | null;
  /** True when a row exists (the first save creates it). */
  persisted: boolean;
}

function isStep(value: string | null): value is WizardStep {
  return WIZARD_STEPS.some((step) => step === value);
}

function progressOf(raw: Record<string, unknown>): WizardRecord['progress'] {
  const progress: Partial<Record<WizardStep, 'done' | 'skipped'>> = {};
  for (const step of WIZARD_STEPS) {
    const value = raw[step];
    if (value === 'done' || value === 'skipped') progress[step] = value;
  }
  return progress;
}

function toStored(row: OnboardingStateRow | undefined): StoredState {
  if (!row) {
    return {
      progress: {},
      answers: {},
      currentStep: null,
      completedAt: null,
      checklistDismissedAt: null,
      persisted: false,
    };
  }
  // What was saved passed validation on the way in; reading it back keeps only what still fits the
  // contract, so an old row can never break the screen.
  const answers = WizardAnswers.safeParse(row.answers);
  return {
    progress: progressOf(row.stepProgress),
    answers: answers.success ? answers.data : {},
    currentStep: isStep(row.currentStep) ? row.currentStep : null,
    completedAt: row.wizardCompletedAt,
    checklistDismissedAt: row.checklistDismissedAt,
    persisted: true,
  };
}

export async function loadStored(tx: Tx): Promise<StoredState> {
  const [row] = await tx.select().from(onboardingState);
  return toStored(row);
}

export interface StatePatch {
  progress?: WizardRecord['progress'];
  answers?: WizardAnswers;
  currentStep?: WizardStep | null;
  completed?: { at: Date; by: string };
  checklistDismissed?: { at: Date; by: string } | null;
}

/** Creates the organization's row on the first save and updates it afterwards. */
export async function saveStored(tx: Tx, patch: StatePatch): Promise<void> {
  const values = {
    ...(patch.progress === undefined ? {} : { stepProgress: patch.progress }),
    ...(patch.answers === undefined ? {} : { answers: patch.answers }),
    ...(patch.currentStep === undefined ? {} : { currentStep: patch.currentStep }),
    ...(patch.completed === undefined
      ? {}
      : { wizardCompletedAt: patch.completed.at, wizardCompletedBy: patch.completed.by }),
    ...(patch.checklistDismissed === undefined
      ? {}
      : patch.checklistDismissed === null
        ? { checklistDismissedAt: null, checklistDismissedBy: null }
        : {
            checklistDismissedAt: patch.checklistDismissed.at,
            checklistDismissedBy: patch.checklistDismissed.by,
          }),
  };
  await tx
    .insert(onboardingState)
    .values({ tenantId: sql`current_setting('app.tenant_id')::uuid`, ...values })
    .onConflictDoUpdate({
      target: onboardingState.tenantId,
      set: { ...values, updatedAt: sql`now()` },
    });
}

/** Whether the wizard of the organization is finished. A missing row means it never started. */
export async function isWizardCompleted(tx: Tx): Promise<boolean> {
  const [row] = await tx.select({ at: onboardingState.wizardCompletedAt }).from(onboardingState);
  return row?.at != null;
}

/** How long after its creation an organization can still add the professional role to its owner. */
export const SELF_ROLE_WINDOW_DAYS = 30;

/**
 * Whether the owner can still add the professional role to themselves (D21): while the wizard is
 * not finished AND the organization is young. Without the age limit an organization that never
 * finished the wizard (or never started it) would keep the door open for ever.
 */
export async function isSelfRoleOpen(tx: Tx, now: Date): Promise<boolean> {
  if (await isWizardCompleted(tx)) return false;
  // Row level security already limits the table to this organization; the filter says it too.
  const [row] = await tx
    .select({ createdAt: tenant.createdAt })
    .from(tenant)
    .where(eq(tenant.id, sql`current_setting('app.tenant_id')::uuid`));
  if (!row) return false;
  return now.getTime() - row.createdAt.getTime() < SELF_ROLE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}
