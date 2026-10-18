import type { AuditActor } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';
import type { AppointmentEvents } from '../../../platform/events/appointment-events.js';
import { AppError } from '../../../platform/http/problem.js';
import {
  createSchedulingPorts,
  transitionAppointment,
  type BookActor,
} from '../../scheduling/index.js';

import type { AppointmentContext } from './context.js';

/**
 * What a patient does to their own appointment from a message: confirm it or cancel it. The patient
 * has no account, so the system carries the change out on their behalf; the appointment's history
 * and the audit trail say it was the patient who cancelled. Used by the links of an email and by
 * the fixed replies on WhatsApp.
 */

export interface PatientActionDeps {
  keys: TenantKeys;
  /** Where the appointment events go, so a confirmation or cancellation reaches the planner. */
  events: AppointmentEvents;
}

const ON_BEHALF_OF_PATIENT: BookActor = {
  userId: SYSTEM_USER_ID,
  permissions: new Set<string>(),
  professionalId: null,
};

/**
 * Applies the action to the appointment as it is NOW (its version is read, not guessed). Returns
 * false when the state machine says no (already confirmed, already cancelled).
 */
export async function actForPatient(
  deps: PatientActionDeps,
  tx: Tx,
  input: {
    appointment: AppointmentContext;
    action: 'confirm' | 'cancel';
    now: Date;
    actor: AuditActor;
  },
): Promise<boolean> {
  try {
    // A savepoint: a change that something refuses half way (a subscriber of the event bus says
    // no after the status was written) leaves nothing behind, and the caller can go on.
    await tx.transaction((inner) =>
      transitionAppointment(createSchedulingPorts(inner, deps), {
        appointmentId: input.appointment.id,
        action: input.action,
        actor: ON_BEHALF_OF_PATIENT,
        auditActor: { ...input.actor, userId: SYSTEM_USER_ID },
        now: input.now,
        expectedVersion: input.appointment.version,
        // The patient acted, with their link or a reply: the history says so.
        actorKind: 'patient',
        ...(input.action === 'cancel'
          ? { cancellation: { cancelledBy: 'patient', reasonCode: 'patient_request' } as const }
          : {}),
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof AppError) return false;
    throw error;
  }
}
