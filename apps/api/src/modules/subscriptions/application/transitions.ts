import type { SubscriptionStatus } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';

import {
  subscription,
  type PlanRow,
  type SubscriptionRow,
} from '../../../db/schema/subscriptions.js';
import { tenant } from '../../../db/schema/tenant.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { TenantCancelledPort } from '../../tenancy/index.js';
import {
  transition,
  type SubscriptionEvent,
  type Transition,
} from '../domain/subscription-state.js';

import { DAY_MS, SYSTEM_ACTOR } from './common.js';
import { CURRENT_TENANT } from './store.js';

/** What `applyEvent` needs besides the event: the locked row, its plan and the instant. */
export interface ApplyEventInput {
  tx: Tx;
  /** The subscription, locked by the caller (`FOR UPDATE`) in this transaction. */
  row: SubscriptionRow;
  plan: Pick<PlanRow, 'graceDays' | 'key'>;
  event: SubscriptionEvent;
  now: Date;
  /** Delivered when the subscription reaches `cancelled`, in this transaction. */
  tenantCancelled?: TenantCancelledPort | undefined;
  actor?: AuditActor;
}

export interface ApplyEventResult {
  /** The row after the event (the same row when nothing changed). */
  row: SubscriptionRow;
  transition: Transition;
}

/**
 * Applies an event to a subscription, in the transaction of the caller. The state machine decides
 * (`domain/subscription-state.ts`); this writes what it said, and everything that follows from a
 * change of state, in the same transaction so none of it can be left half done:
 *
 * - the subscription row, with its new status, its grace and the end of what is paid;
 * - `tenant.status`, which is DERIVED from the subscription and never set on its own: read-only sets
 *   `read_only_since`, going back to active clears it, cancelled leaves it as it was;
 * - the dunning bookkeeping: the grace counts from the instant it began, and a settlement clears it;
 * - the audit entry `subscription.state_changed`, and `tenant.cancelled` when the subscription ends;
 * - the delivery of `TenantCancelled`, so retention starts in the very transaction that cancelled.
 *
 * Nothing here talks to the provider. An event the machine does not act on writes nothing.
 */
export async function applyEvent(input: ApplyEventInput): Promise<ApplyEventResult> {
  const { tx, row, plan, now } = input;
  const result = transition(
    {
      status: row.status as SubscriptionStatus,
      trialEndsAt: row.trialEndsAt,
      graceEndsAt: row.graceEndsAt,
      paidThrough: row.paidThrough,
      authorized: row.authorizationState === 'authorized',
    },
    input.event,
    { now, graceDays: plan.graceDays },
  );
  const sameGrace = result.graceEndsAt?.getTime() === row.graceEndsAt?.getTime();
  const samePaid = result.paidThrough?.getTime() === row.paidThrough?.getTime();
  if (!result.changed && sameGrace && samePaid) return { row, transition: result };

  const graceStart =
    result.graceEndsAt === null
      ? null
      : new Date(result.graceEndsAt.getTime() - plan.graceDays * DAY_MS);
  const [updated] = await tx
    .update(subscription)
    .set({
      status: result.to,
      graceEndsAt: result.graceEndsAt,
      paidThrough: result.paidThrough,
      version: row.version + 1,
      ...(result.changed && result.to === 'past_due'
        ? { firstFailureAt: graceStart, dunningStep: 0 }
        : {}),
      ...(result.changed && result.to === 'active' && row.status !== 'cancelling'
        ? { firstFailureAt: null, dunningStep: 0 }
        : {}),
      ...(result.changed && result.to === 'cancelling' ? { cancelRequestedAt: now } : {}),
      ...(result.changed && row.status === 'cancelling' && result.to !== 'cancelled'
        ? { cancelRequestedAt: null }
        : {}),
    })
    .where(eq(subscription.id, row.id))
    .returning();
  if (!updated) throw new Error('the subscription could not be updated');

  if (result.changed) {
    await syncTenantStatus(tx, result.tenantStatus, now);
    await audit(tx, {
      action: 'subscription.state_changed',
      outcome: 'allow',
      actor: input.actor ?? SYSTEM_ACTOR,
      resourceType: 'subscription',
      resourceId: row.id,
      metadata: { from: result.from, to: result.to, event: input.event.type, plan: plan.key },
    });
    if (result.publishCancelled) {
      await audit(tx, {
        action: 'tenant.cancelled',
        outcome: 'allow',
        actor: input.actor ?? SYSTEM_ACTOR,
        resourceType: 'tenant',
        resourceId: row.tenantId,
        metadata: { source: 'subscription', via: input.event.type },
      });
      await input.tenantCancelled?.publishCancelled(tx, {
        tenantId: row.tenantId,
        cancelledAt: now,
        source: 'subscription',
      });
    }
  }
  return { row: updated, transition: result };
}

/**
 * Makes `tenant.status` follow the subscription. Read-only keeps the instant it began (the gate of
 * the queued AFIP invoices compares with it); going back to active clears it.
 */
async function syncTenantStatus(
  tx: Tx,
  derived: 'active' | 'read_only' | 'cancelled',
  now: Date,
): Promise<void> {
  const [current] = await tx
    .select({ status: tenant.status })
    .from(tenant)
    .where(eq(tenant.id, CURRENT_TENANT));
  if (!current || current.status === derived) return;
  await tx
    .update(tenant)
    .set({
      status: derived,
      ...(derived === 'read_only' ? { readOnlySince: now } : {}),
      ...(derived === 'active' ? { readOnlySince: null } : {}),
    })
    .where(eq(tenant.id, CURRENT_TENANT));
}
