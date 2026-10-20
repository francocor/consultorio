import { UNLIMITED_QUOTA, type QuotaPolicy } from '../../notifications/index.js';

/**
 * The WhatsApp quota of the plan (task 6.26, SUB-09). Seam skeleton: until the subscriptions track
 * fills it in, the policy of Stage 3 holds (no quota, everything is counted). The real one returns
 * the same for an exempt organization, so a single-tenant deployment keeps being metered without
 * being limited, and its rollback is to return this one again.
 */
export function createQuotaPolicy(): QuotaPolicy {
  return UNLIMITED_QUOTA;
}
