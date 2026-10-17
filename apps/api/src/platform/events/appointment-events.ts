import type { AppointmentStatus } from '@consultorio/contracts';

import type { Tx } from '../db/tenant-context.js';

/**
 * The appointment event bus (Stage 3, "Patient engagement"). Scheduling publishes what happened to
 * an appointment; reminders, the waitlist and video links subscribe, so scheduling code never calls
 * them (the module rule: capabilities talk through events and `index.ts`, never through the tables
 * of one another).
 *
 * Delivery is synchronous and inside the transaction of the business write: `publish` awaits every
 * subscriber, in the order they subscribed, and a subscriber that throws fails the publish, so the
 * booking, the move or the cancellation rolls back with it. Nothing is delivered after commit, and
 * nothing is lost if the process dies. A subscriber that needs slow work enqueues a job (in the
 * same transaction) instead of doing it.
 */

/** What an event says about an appointment. Administrative data only, never clinical. */
export interface AppointmentFacts {
  appointmentId: string;
  patientId: string;
  professionalId: string;
  locationId: string;
  appointmentTypeId: string;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  source: 'staff' | 'online' | 'waitlist_offer';
  /** The version after the change. A subscriber drops work planned for an older one. */
  version: number;
}

export type CancelledByKind = 'patient' | 'professional' | 'organization';

/** Where an appointment was before it moved. */
export interface PreviousPlacement {
  professionalId: string;
  locationId: string;
  startsAt: Date;
  endsAt: Date;
}

export type SlotFreedCause = 'cancelled' | 'rescheduled' | 'reassigned' | 'block_removed';

/**
 * Exactly one primary event per scheduling action (`created`, `status_changed`, `cancelled`,
 * `rescheduled`, `reassigned`, `patient_changed`), plus `slot_freed` when time became available:
 * on a cancellation, on a move away from a slot and on the removal of a block. A hold that runs out
 * never publishes `slot_freed`: nobody gave that time back, and the waitlist must not react to it.
 */
export type AppointmentEvent =
  | { kind: 'created'; tenantId: string; appointment: AppointmentFacts }
  | {
      kind: 'status_changed';
      tenantId: string;
      appointment: AppointmentFacts;
      fromStatus: AppointmentStatus;
    }
  | {
      kind: 'cancelled';
      tenantId: string;
      appointment: AppointmentFacts;
      fromStatus: AppointmentStatus;
      cancelledBy: CancelledByKind | null;
    }
  | {
      kind: 'rescheduled' | 'reassigned';
      tenantId: string;
      appointment: AppointmentFacts;
      previous: PreviousPlacement;
    }
  | {
      /** An unconfirmed appointment was moved to another patient record (identity review). */
      kind: 'patient_changed';
      tenantId: string;
      appointment: AppointmentFacts;
      previousPatientId: string;
    }
  | {
      kind: 'slot_freed';
      tenantId: string;
      cause: SlotFreedCause;
      /** The range that became free. A person or a place is null when a block covered all. */
      slot: {
        professionalId: string | null;
        locationId: string | null;
        startsAt: Date;
        endsAt: Date;
      };
      /** The appointment that left the slot; null when a block was removed. */
      appointment: AppointmentFacts | null;
    };

export type AppointmentEventKind = AppointmentEvent['kind'];

/** An event as the code that raises it writes it: the tenant is read from the transaction. */
export type AppointmentEventInput = AppointmentEvent extends infer E
  ? E extends AppointmentEvent
    ? Omit<E, 'tenantId'>
    : never
  : never;

export type AppointmentEventHandler = (tx: Tx, event: AppointmentEvent) => Promise<void>;

export interface AppointmentEvents {
  /** Delivers the event to every subscriber, inside `tx`. Rejects when one of them does. */
  publish(tx: Tx, event: AppointmentEvent): Promise<void>;
  /** Registers a subscriber; the returned function removes it. */
  subscribe(handler: AppointmentEventHandler): () => void;
}

/**
 * One bus per application, not a module-level singleton: the integration tests build many
 * applications in one process, and their subscribers must not pile up on a shared list.
 */
export function createAppointmentEvents(): AppointmentEvents {
  const handlers: AppointmentEventHandler[] = [];

  return {
    async publish(tx, event) {
      // A copy, so a subscriber that unsubscribes while it runs does not skip its neighbour.
      for (const handler of [...handlers]) await handler(tx, event);
    },
    subscribe(handler) {
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
  };
}
