import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * What happens to an organization when it ends (Stage 6, tenancy: "Tenant cancellation export").
 * Two writers can end it: the subscription reaching `cancelled` after the owner cancelled
 * (subscriptions, S6.04), and the operator cancelling a single-tenant deployment or testing locally
 * (S6.36). The retention track (cancellation export and archive, S6.08 to S6.10) subscribes, so the
 * writers never call it and billing does not wait for retention.
 *
 * Delivery is synchronous and inside the transaction that moved the organization to `cancelled`,
 * like the appointment events: `publishCancelled` awaits every subscriber in the order they
 * subscribed, and a subscriber that throws fails the publish, so the cancellation rolls back with it.
 * A subscriber does no slow work and calls no outside service: it enqueues a job (`export.build`) in
 * the same transaction. A subscriber must be idempotent (keyed by the organization): the publisher
 * publishes once per cancellation, but a retried transaction publishes again.
 */

/** Who ended the organization. */
export type CancellationSource = 'subscription' | 'operator';

/** What a subscriber is told. Administrative facts only. */
export interface TenantCancelledEvent {
  tenantId: string;
  cancelledAt: Date;
  source: CancellationSource;
}

export type TenantCancelledHandler = (tx: Tx, event: TenantCancelledEvent) => Promise<void>;

/** The door the writers use: they can say an organization was cancelled, and nothing else. */
export interface TenantCancelledPort {
  /** Delivers the event to every subscriber, inside `tx`. Rejects when one of them does. */
  publishCancelled(tx: Tx, event: TenantCancelledEvent): Promise<void>;
}

/** The whole bus: the writers' door plus the subscription of the retention track. */
export interface TenantLifecycle extends TenantCancelledPort {
  /** Registers a subscriber; the returned function removes it. */
  onCancelled(handler: TenantCancelledHandler): () => void;
}

/**
 * One bus per application, not a module-level singleton: the integration tests build many
 * applications in one process, and their subscribers must not pile up on a shared list.
 */
export function createTenantLifecycle(): TenantLifecycle {
  const handlers: TenantCancelledHandler[] = [];

  return {
    async publishCancelled(tx, event) {
      // A copy, so a subscriber that unsubscribes while it runs does not skip its neighbour.
      for (const handler of [...handlers]) await handler(tx, event);
    },
    onCancelled(handler) {
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
  };
}
