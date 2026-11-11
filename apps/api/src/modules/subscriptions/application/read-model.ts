import type {
  PlanDto,
  SubscriptionDto,
  SubscriptionNextTransition,
  SubscriptionResponse,
} from '@consultorio/contracts';

import type { PlanRow, SubscriptionRow } from '../../../db/schema/subscriptions.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { coverageEnd } from '../domain/subscription-state.js';

import {
  countActiveProfessionalsNow,
  findPlan,
  findSubscription,
  readTenantBilling,
  startingPlan,
} from './store.js';

export function planDtoOf(row: PlanRow): PlanDto {
  return {
    key: row.key,
    name: row.name,
    currency: 'ARS',
    pricePerProfessionalCents: row.pricePerProfessionalCents,
    maxActiveProfessionals: row.maxActiveProfessionals,
    whatsappQuotaPerProfessional: row.whatsappQuotaPerProfessional,
    overageUnitPriceCents: row.overageUnitPriceCents,
    overageCapDefault: row.overageCapDefault,
    overageCapMax: row.overageCapMax,
    trialDays: row.trialDays,
    graceDays: row.graceDays,
  };
}

/** What happens next to the subscription, and when: the owner always sees the next date. */
export function nextTransitionOf(row: SubscriptionRow): SubscriptionNextTransition | null {
  switch (row.status) {
    case 'trial':
      return { kind: 'trial_ends', at: row.trialEndsAt.toISOString() };
    case 'past_due':
      return row.graceEndsAt ? { kind: 'read_only_at', at: row.graceEndsAt.toISOString() } : null;
    case 'cancelling':
      // Service lasts until the later of what was paid and the trial the owner was still in.
      return { kind: 'service_ends', at: coverageEnd(row).toISOString() };
    default:
      return null;
  }
}

export interface ReadModelOptions {
  /** The payments provider is a simulator. */
  simulated: boolean;
}

/**
 * The subscription as its owner sees it. An exempt organization has none and says so; one that is
 * not exempt and has no subscription yet gets the plan it would start on. Nothing here is a card
 * number: the payment method is the label the provider gave.
 */
export async function describeSubscription(
  tx: Tx,
  options: ReadModelOptions,
): Promise<SubscriptionResponse> {
  const billing = await readTenantBilling(tx);
  if (billing.exempt) {
    return { exempt: true, subscription: null, plan: null, simulated: options.simulated };
  }
  const current = await findSubscription(tx);
  if (!current) {
    return {
      exempt: false,
      subscription: null,
      plan: planDtoOf(await startingPlan(tx)),
      simulated: options.simulated,
    };
  }
  const plan = await findPlan(tx, current.planId);
  const activeProfessionals = await countActiveProfessionalsNow(tx);
  const subscription: SubscriptionDto = {
    status: current.status as SubscriptionDto['status'],
    plan: planDtoOf(plan),
    trialEndsAt: current.trialEndsAt.toISOString(),
    graceEndsAt: current.graceEndsAt?.toISOString() ?? null,
    paidThrough: current.paidThrough?.toISOString() ?? null,
    nextTransition: nextTransitionOf(current),
    authorization: current.authorizationState as SubscriptionDto['authorization'],
    paymentMethodLabel: current.paymentMethodLabel,
    nextChargeAt: current.nextChargeAt?.toISOString() ?? null,
    authorizedAmountCents: current.authorizedAmountCents,
    overageCapMessages: current.overageCapMessages,
    activeProfessionals,
    monthlyPriceCents: activeProfessionals * plan.pricePerProfessionalCents,
    needsAttention: current.attentionReason !== null,
  };
  return {
    exempt: false,
    subscription,
    plan: planDtoOf(plan),
    simulated: options.simulated,
  };
}
