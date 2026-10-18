import { and, eq, gt, ne, sql } from 'drizzle-orm';

import { bookingSubmission } from '../../../db/schema/booking-submission.js';
import { publicHold } from '../../../db/schema/online-booking.js';
import { patient } from '../../../db/schema/patients.js';
import { appointment, slotHold } from '../../../db/schema/scheduling.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { clientKeyOf, type RateLimitStore } from '../../../platform/http/rate-limit.js';
import type { Metrics } from '../../../platform/metrics.js';

/** The limits of the public flow (online-booking, "Abuse protection"). */
export const ABUSE_LIMITS = {
  /** Slots one address may hold in ten minutes (the life of a hold), however many sessions it opens. */
  holdsPerSource: 10,
  /** Forms one address may send in an hour. */
  submissionsPerSource: 10,
  /** Forms one link may take in an hour, whatever the addresses. */
  submissionsPerLink: 200,
  /** Future online appointments one contact (email or document) may hold with the organization. */
  futureAppointmentsPerContact: 3,
  /** Bookings one contact may complete in a day. */
  bookingsPerContactPerDay: 3,
} as const;

const HOUR = 3_600_000;

export type SuspiciousReason = 'rate_limit' | 'code_flood' | 'hoarding';

const HOLD_WINDOW = 600_000;
/** One entry per link and reason in this long. */
const SUSPICIOUS_WINDOW = 600_000;

export interface Abuse {
  /** Counts a hold request from this address; false when it already has too many. */
  allowHoldFrom(tenantId: string, ip: string): Promise<boolean>;
  /** Counts a form from this address; false when it is over its allowance for the hour. */
  allowSubmissionFrom(tenantId: string, ip: string): Promise<boolean>;
  /** Counts a form on this link; false when the link is over its allowance for the hour. */
  allowSubmissionOn(tenantId: string, linkId: string): Promise<boolean>;
  /** Writes the entry the administrator reads and counts it. Never carries who it was. */
  recordSuspicious(
    tx: Tx,
    input: { actor: AuditActor; reason: SuspiciousReason; linkId: string },
  ): Promise<void>;
}

export function createAbuse(deps: { store: RateLimitStore; metrics: Metrics }): Abuse {
  async function within(key: string, max: number, window = HOUR): Promise<boolean> {
    try {
      const state = await deps.store.hit(key, window);
      return state.count <= max;
    } catch {
      // The counters are best effort (design 4.5): a store that fails does not close the form.
      return true;
    }
  }

  return {
    allowHoldFrom: (tenantId, ip) =>
      within(
        `booking|hold|source|${tenantId}|${clientKeyOf(ip)}`,
        ABUSE_LIMITS.holdsPerSource,
        HOLD_WINDOW,
      ),
    allowSubmissionFrom: (tenantId, ip) =>
      within(
        `booking|submission|source|${tenantId}|${clientKeyOf(ip)}`,
        ABUSE_LIMITS.submissionsPerSource,
      ),
    allowSubmissionOn: (tenantId, linkId) =>
      within(`booking|submission|link|${tenantId}|${linkId}`, ABUSE_LIMITS.submissionsPerLink),

    async recordSuspicious(tx, input) {
      // Every one is counted; only the first of a kind per link and window is written down, so a
      // flood cannot fill the audit trail.
      deps.metrics.increment('booking_suspicious_total', { reason: input.reason });
      if (
        !(await within(`booking|suspicious|${input.linkId}|${input.reason}`, 1, SUSPICIOUS_WINDOW))
      ) {
        return;
      }
      await audit(tx, {
        action: 'booking.suspicious',
        outcome: 'deny',
        // What happened, never who: the address and the browser of the visitor are not kept.
        actor: { ...input.actor, ip: null, userAgent: null },
        resourceType: 'booking_link',
        resourceId: input.linkId,
        // What happened, never who: no address, name or document.
        metadata: { reason: input.reason },
      });
    },
  };
}

/**
 * Future online appointments that were booked with an email address that the visitor verified. A
 * cancelled appointment gives its place back. Only a verified address counts: what a visitor types
 * in a form proves nothing until the code arrives.
 */
export async function futureOnlineByEmail(
  tx: Tx,
  input: { email: string; now: Date },
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(appointment)
    .innerJoin(bookingSubmission, eq(bookingSubmission.appointmentId, appointment.id))
    .where(
      and(
        eq(bookingSubmission.email, input.email),
        eq(bookingSubmission.status, 'verified'),
        eq(appointment.source, 'online'),
        ne(appointment.status, 'cancelled'),
        gt(appointment.startsAt, input.now),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Future online appointments that stand on the record with this document. It is how the same
 * person reappears under a different address, so it is also how a stranger would pile appointments
 * on somebody else's record. It is read only after the code of a booking was accepted, and what the
 * booking does with it never shows to the visitor.
 */
export async function futureOnlineByDocument(
  tx: Tx,
  input: { document: { type: string; number: string }; now: Date },
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(appointment)
    .innerJoin(patient, eq(patient.id, appointment.patientId))
    .where(
      and(
        eq(patient.nationalIdType, input.document.type),
        eq(patient.nationalId, input.document.number),
        eq(appointment.source, 'online'),
        ne(appointment.status, 'cancelled'),
        gt(appointment.startsAt, input.now),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Future appointments booked through a link whose identity reception has not confirmed: what a
 * stranger could pile on other people's records through that link, AND the ones that were put on a
 * record of their own because the record with the document could not take them (judgment day round
 * 2, finding C5: those were not counted, so a link could be filled with them without ever reaching
 * its limit).
 */
export async function unconfirmedOnLink(
  tx: Tx,
  input: { linkId: string; now: Date },
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(appointment)
    .innerJoin(slotHold, eq(slotHold.appointmentId, appointment.id))
    .innerJoin(publicHold, eq(publicHold.holdId, slotHold.id))
    .where(
      and(
        eq(publicHold.bookingLinkId, input.linkId),
        eq(appointment.identityConfirmed, false),
        eq(appointment.source, 'online'),
        ne(appointment.status, 'cancelled'),
        gt(appointment.startsAt, input.now),
      ),
    );
  return row?.n ?? 0;
}

/** Bookings an email completed in the last 24 hours. */
export async function bookingsInLastDay(tx: Tx, email: string, now: Date): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(bookingSubmission)
    .where(
      and(
        eq(bookingSubmission.email, email),
        eq(bookingSubmission.status, 'verified'),
        gt(bookingSubmission.verifiedAt, new Date(now.getTime() - 24 * HOUR)),
      ),
    );
  return rows[0]?.n ?? 0;
}
