import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';

import { actionToken } from '../../../db/schema/action-token.js';
import { membership } from '../../../db/schema/identity.js';
import { professional } from '../../../db/schema/staff.js';
import {
  plan,
  subscription,
  type PlanRow,
  type SubscriptionRow,
} from '../../../db/schema/subscriptions.js';
import { tenant } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { PlanLimits } from '../domain/plan-limits.js';

/** The organization of the transaction, as a column value. */
export const CURRENT_TENANT = sql`current_setting('app.tenant_id')::uuid`;

export interface TenantBilling {
  id: string;
  /** A demo, or a deployment without billing: no subscription, no trial, no limit. */
  exempt: boolean;
  status: string;
}

/** The organization of the transaction, and whether billing applies to it. */
export async function readTenantBilling(tx: Tx): Promise<TenantBilling> {
  const [row] = await tx
    .select({
      id: tenant.id,
      billingExempt: tenant.billingExempt,
      isDemo: tenant.isDemo,
      status: tenant.status,
    })
    .from(tenant)
    .where(eq(tenant.id, CURRENT_TENANT));
  if (!row) throw new Error('the organization of the transaction does not exist');
  return { id: row.id, exempt: row.billingExempt || row.isDemo, status: row.status };
}

export async function findSubscription(tx: Tx): Promise<SubscriptionRow | null> {
  const [row] = await tx
    .select()
    .from(subscription)
    .where(eq(subscription.tenantId, CURRENT_TENANT));
  return row ?? null;
}

/** The subscription of the organization, locked until the end of the transaction. */
export async function lockSubscription(tx: Tx): Promise<SubscriptionRow | null> {
  const [row] = await tx
    .select()
    .from(subscription)
    .where(eq(subscription.tenantId, CURRENT_TENANT))
    .for('update');
  return row ?? null;
}

export async function findPlan(tx: Tx, planId: string): Promise<PlanRow> {
  const [row] = await tx.select().from(plan).where(eq(plan.id, planId));
  if (!row) throw new Error('the plan of a subscription does not exist');
  return row;
}

/** The plan a new organization starts on: the active plan named `standard`, else the oldest active one. */
export async function startingPlan(tx: Tx): Promise<PlanRow> {
  const rows = await tx
    .select()
    .from(plan)
    .where(eq(plan.active, true))
    .orderBy(sql`(${plan.key} = 'standard') desc`, asc(plan.createdAt), asc(plan.id))
    .limit(1);
  const [row] = rows;
  if (!row) throw new Error('there is no active plan to start a subscription on');
  return row;
}

export function limitsOf(
  row: Pick<PlanRow, 'pricePerProfessionalCents' | 'maxActiveProfessionals'>,
): PlanLimits {
  return {
    pricePerProfessionalCents: row.pricePerProfessionalCents,
    maxActiveProfessionals: row.maxActiveProfessionals,
  };
}

/**
 * The active professionals of the organization today (`domain/active-professional.ts` is the
 * definition; this is the same rule as a query): an active membership with the `professional` role
 * and an active profile.
 */
export async function countActiveProfessionalsNow(tx: Tx): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(membership)
    .innerJoin(
      professional,
      and(
        eq(professional.tenantId, membership.tenantId),
        eq(professional.membershipId, membership.id),
      ),
    )
    .where(
      and(
        eq(membership.status, 'active'),
        sql`'professional' = any(${membership.roles})`,
        eq(professional.status, 'active'),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Invitations to be a professional that nobody accepted yet and that can still be: each one is a
 * seat that will be taken, so it counts against the limit when the next one is issued.
 */
export async function countOpenProfessionalInvitations(tx: Tx, now: Date): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(actionToken)
    .where(
      and(
        eq(actionToken.kind, 'staff_invitation'),
        isNull(actionToken.revokedAt),
        gt(actionToken.expiresAt, now),
        sql`${actionToken.uses} < ${actionToken.maxUses}`,
        sql`${actionToken.payload} -> 'roles' ? 'professional'`,
      ),
    );
  return row?.count ?? 0;
}
