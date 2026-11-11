import { sql } from 'drizzle-orm';

import { UNLIMITED_QUOTA, type QuotaPolicy } from '../../notifications/index.js';

import { claimNotice } from './notices.js';
import { findPlan, findSubscription, readTenantBilling } from './store.js';
import { quotaSituation } from './usage.js';

/**
 * The WhatsApp quota of the plan (SUB-09, SUB-11). It replaces the counting-only default of Stage 3:
 *
 * - **Each active professional has a monthly quota** from the plan, prorated by the days they were
 *   active (`usage.ts`): a professional deactivated mid-period stops receiving quota by the same rule
 *   as the price. Unused quota does not carry over (the count and the quota are per period).
 * - **Messages beyond the quota are overage** while the organization's cap is above zero and has not
 *   been reached in the period (the cap is a number of messages per organization, never unlimited), and
 *   the subscription is past its trial. Otherwise `overageAllowed` is false: the message falls back to
 *   email and the owner is told once per period.
 * - **Deciding is serialized.** The count of overage messages of the period is read under an advisory
 *   lock of the organization and the period, held until the end of the transaction that reserves the
 *   place, so two messages prepared at the same moment cannot both take the last overage message.
 * - **No billing, no limit.** An organization without a subscription (a demo, a deployment that bills
 *   outside the platform) has no quota: everything is allowed and everything is counted, which is what
 *   keeps single-tenant metering going. Rolling back to the policy of Stage 3 is returning
 *   `UNLIMITED_QUOTA` from this function.
 *
 * `clock` is only for tests that move time; the wiring uses the system clock.
 */
export function createQuotaPolicy(options: { clock?: () => Date } = {}): QuotaPolicy {
  const clock = options.clock ?? (() => new Date());
  return {
    async limitFor(tx, professionalId, period) {
      const billing = await readTenantBilling(tx);
      if (billing.exempt) return UNLIMITED_QUOTA.limitFor(tx, professionalId, period);
      const sub = await findSubscription(tx);
      if (!sub) return UNLIMITED_QUOTA.limitFor(tx, professionalId, period);
      const plan = await findPlan(tx, sub.planId);

      // The overage decision reads the count of the whole organization: nobody else decides meanwhile.
      if (sub.status !== 'trial' && sub.overageCapMessages > 0) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`overage:${period}:`} || current_setting('app.tenant_id'), 0))`,
        );
      }
      const situation = await quotaSituation(tx, { sub, plan, period, now: clock() });
      const mine = situation.professionals.find((entry) => entry.professionalId === professionalId);
      const limit = mine?.quota ?? 0;
      const overageAllowed = !situation.capReached;

      // The professional cannot send one more by WhatsApp: the owner is told, once for the period.
      if (!overageAllowed && (mine?.count ?? 0) >= limit) {
        await claimNotice(tx, sub.id, 'overage_cap_reached', period);
      }
      return { limit, overageAllowed };
    },
  };
}
