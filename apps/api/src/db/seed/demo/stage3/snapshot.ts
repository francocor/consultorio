import { asc, eq } from 'drizzle-orm';

import { SYSTEM_USER_ID, type WithTenant } from '../../../../platform/db/tenant-context.js';
import { channelPreference } from '../../../schema/channel-preference.js';
import { message } from '../../../schema/notifications.js';
import { bookingLink } from '../../../schema/online-booking.js';
import { patient } from '../../../schema/patients.js';
import { appointment } from '../../../schema/scheduling.js';
import { videoSession } from '../../../schema/teleconsultation.js';
import { waitlistEntry, waitlistOffer } from '../../../schema/waitlist.js';

/**
 * The logical content of the Stage 3 part of a demonstration organization: what a person would
 * notice, without ids and timestamps. Two seeds of the same day give equal snapshots (the booking
 * links are told apart only by the address, which belongs to the organization).
 */
export interface DemoStage3Snapshot {
  bookingLinks: { enabled: boolean; types: number; path: string }[];
  onlineBookings: { patient: string; status: string; identityConfirmed: boolean }[];
  virtual: { patient: string; session: string; pendingReason: string | null }[];
  waitlist: { patient: string; status: string; manualContactOnly: boolean; offers: string[] }[];
  messages: { kind: string; channel: string; status: string; patient: string }[];
  choices: { patient: string; channel: string; state: string; source: string }[];
}

export async function snapshotDemoStage3(
  withTenant: WithTenant,
  tenantId: string,
): Promise<DemoStage3Snapshot> {
  return withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const people = await tx.select().from(patient);
    const name = new Map(people.map((row) => [row.id, `${row.familyName}, ${row.givenNames}`]));
    const nameOf = (id: string) => name.get(id) ?? '?';
    const sorted = <T>(rows: T[], key: (row: T) => string) =>
      [...rows].sort((a, b) => key(a).localeCompare(key(b)));

    const links = await tx.select().from(bookingLink).orderBy(asc(bookingLink.createdAt));
    const online = await tx.select().from(appointment).where(eq(appointment.source, 'online'));
    const sessions = await tx
      .select({
        patientId: appointment.patientId,
        status: videoSession.status,
        pendingReason: videoSession.pendingReason,
      })
      .from(videoSession)
      .innerJoin(appointment, eq(appointment.id, videoSession.appointmentId));
    const entries = await tx.select().from(waitlistEntry);
    const offers = await tx.select().from(waitlistOffer);
    const messages = await tx.select().from(message);
    const choices = await tx.select().from(channelPreference);

    return {
      bookingLinks: links.map((link) => ({
        enabled: link.enabled,
        types: link.typeIds.length,
        path: link.slug,
      })),
      onlineBookings: sorted(
        online.map((row) => ({
          patient: nameOf(row.patientId),
          status: row.status,
          identityConfirmed: row.identityConfirmed,
        })),
        (row) => `${row.patient}|${row.status}`,
      ),
      virtual: sorted(
        sessions.map((row) => ({
          patient: nameOf(row.patientId),
          session: row.status,
          pendingReason: row.pendingReason,
        })),
        (row) => `${row.patient}|${row.session}`,
      ),
      waitlist: sorted(
        entries.map((row) => ({
          patient: nameOf(row.patientId),
          status: row.status,
          manualContactOnly: row.manualContactOnly,
          offers: offers
            .filter((offer) => offer.entryId === row.id)
            .map((offer) => offer.status)
            .sort(),
        })),
        (row) => `${row.patient}|${row.status}`,
      ),
      messages: sorted(
        messages.map((row) => ({
          kind: row.kind,
          channel: row.channel,
          status: row.status,
          patient: nameOf(row.patientId),
        })),
        (row) => `${row.patient}|${row.kind}|${row.channel}|${row.status}`,
      ),
      choices: sorted(
        choices.map((row) => ({
          patient: nameOf(row.patientId),
          channel: row.channel,
          state: row.state,
          source: row.source,
        })),
        (row) => `${row.patient}|${row.channel}|${row.state}`,
      ),
    };
  });
}
