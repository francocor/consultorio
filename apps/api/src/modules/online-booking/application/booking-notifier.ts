import type { Tx } from '../../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';

import { renderBookingConfirmationEmail } from './confirmation-email.js';

/** What the patient is told once a booking is confirmed. Administrative facts only. */
export interface BookingNotice {
  tenant: { id: string; slug: string; isDemo: boolean };
  /** The address the patient verified with the code: the only channel the confirmation uses. */
  to: string;
  organizationName: string;
  professionalName: string;
  locationName: string;
  startsAt: Date;
  timeZone: string;
  pendingApproval: boolean;
  /** The token of the link to change or cancel; null when the time has already passed. */
  manageToken: string | null;
}

/**
 * What online booking needs from the messaging side, as a port so the notifications module (track
 * A) can take it over without a change here. Until it does, the email notifier below sends the
 * confirmation itself and the WhatsApp opt-in is not recorded on the patient (the choice stays in
 * the encrypted submission).
 */
export interface BookingNotifier {
  /**
   * Records the WhatsApp opt-in the visitor ticked on the form (source `online_booking`), for a
   * patient created by this booking. Absent while the notifications module has no preferences.
   */
  recordWhatsAppOptIn?(tx: Tx, input: { patientId: string; at: Date }): Promise<void>;
  /**
   * Tells the patient. Called after the booking is committed, never inside its transaction, and
   * exempt from quiet hours: it answers an action of the patient.
   */
  confirmBooking(notice: BookingNotice): Promise<void>;
}

/** The path of the page where the patient changes or cancels. */
export const MANAGE_PATH = '/book/manage';

/** The stand-in until notifications exists: the confirmation goes out as an email, now. */
export function createEmailBookingNotifier(deps: {
  email: EmailSender;
  origins: PublicOrigins;
}): BookingNotifier {
  return {
    async confirmBooking(notice) {
      const manageLink =
        notice.manageToken === null
          ? null
          : `${deps.origins(notice.tenant.slug)}${MANAGE_PATH}/${notice.manageToken}`;
      await deps.email.send({
        to: notice.to,
        tenant: { id: notice.tenant.id, isDemo: notice.tenant.isDemo },
        ...renderBookingConfirmationEmail({
          organizationName: notice.organizationName,
          professionalName: notice.professionalName,
          locationName: notice.locationName,
          startsAt: notice.startsAt,
          timeZone: notice.timeZone,
          pendingApproval: notice.pendingApproval,
          manageLink,
        }),
      });
    },
  };
}
