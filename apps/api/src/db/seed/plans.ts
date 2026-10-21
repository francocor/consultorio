import { PLAN_DEFAULTS } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';

import type { Db } from '../../platform/db/pool.js';
import { plan, planEntitlement } from '../schema/subscriptions.js';

/**
 * The plan every new organization starts on (subscriptions, "Plan catalog and limits"). Prices and
 * limits are configuration: this is the starting row, and the platform operator maintains the table
 * as data afterwards, so a seed never overwrites a plan that already exists. Amounts are whole cents
 * of ARS.
 */
export const STANDARD_PLAN = {
  key: 'standard',
  name: 'Plan Profesional',
  currency: 'ARS',
  /** ARS 18.000,00 per active professional per month. */
  pricePerProfessionalCents: 1_800_000,
  maxActiveProfessionals: 20,
  whatsappQuotaPerProfessional: PLAN_DEFAULTS.whatsappQuotaPerProfessional,
  /** ARS 60,00 per extra WhatsApp message. */
  overageUnitPriceCents: 6_000,
  overageCapDefault: 300,
  overageCapMax: 3_000,
  trialDays: PLAN_DEFAULTS.trialDays,
  graceDays: PLAN_DEFAULTS.graceDays,
} as const;

/** What the starting plan includes, by feature. No feature has a limit of its own. */
export const STANDARD_ENTITLEMENTS = [
  'whatsapp_reminders',
  'online_booking',
  'waitlist',
  'teleconsultation',
  'e_invoicing',
  'e_prescription',
  'patient_portal',
] as const;

/** Loads the starting plan and its entitlements. Idempotent: an existing plan is left as it is. */
export async function seedPlans(db: Db): Promise<void> {
  await db.insert(plan).values(STANDARD_PLAN).onConflictDoNothing({ target: plan.key });
  const [standard] = await db
    .select({ id: plan.id })
    .from(plan)
    .where(sql`${plan.key} = ${STANDARD_PLAN.key}`);
  if (!standard) throw new Error('the starting plan could not be loaded');
  await db
    .insert(planEntitlement)
    .values(STANDARD_ENTITLEMENTS.map((feature) => ({ planId: standard.id, feature })))
    .onConflictDoNothing({ target: [planEntitlement.planId, planEntitlement.feature] });
}
