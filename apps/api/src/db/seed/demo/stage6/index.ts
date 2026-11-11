import { eq } from 'drizzle-orm';

import { SYSTEM_USER_ID } from '../../../../platform/db/tenant-context.js';
import { subscription } from '../../../schema/subscriptions.js';
import { tenant } from '../../../schema/tenant.js';
import type { DemoContributor } from '../contributors.js';
import { DemoSeedError } from '../seed.js';

export {
  PLATFORM_DEMO_TENANTS,
  seedPlatformDemo,
  type PlatformDemoDeps,
  type PlatformDemoResult,
  type PlatformDemoState,
  type PlatformDemoTenant,
} from './platform-tenants.js';

/**
 * The Stage 6 part of the demonstration organization (task 6.47): the exempt state. A demonstration
 * organization is billed outside the platform, so it has no subscription, no statement and no usage
 * record (the database refuses a subscription for it), shows no banner and no limit, and is never
 * made read-only; none of that is data to seed. What the seed does is refuse an organization that
 * would not show that state, so a demo that lost its exemption fails loudly instead of showing a
 * trial banner to a visitor. The organizations that DO have a subscription are the four of
 * `seedPlatformDemo` (`pnpm demo:platform`).
 */
export const seedStage6: DemoContributor = async (context) => {
  const state = await context.withTenant(
    { tenantId: context.tenantId, userId: SYSTEM_USER_ID },
    async (tx) => {
      const [row] = await tx
        .select({ exempt: tenant.billingExempt, isDemo: tenant.isDemo })
        .from(tenant)
        .where(eq(tenant.id, context.tenantId));
      const [billed] = await tx
        .select({ id: subscription.id })
        .from(subscription)
        .where(eq(subscription.tenantId, context.tenantId))
        .limit(1);
      return { exempt: row?.exempt ?? false, isDemo: row?.isDemo ?? false, billed: billed?.id };
    },
  );
  if (!state.isDemo || !state.exempt || state.billed !== undefined) {
    throw new DemoSeedError(
      'The demonstration organization must be billing exempt and have no subscription (Stage 6).',
    );
  }
};
