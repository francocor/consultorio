import {
  APPOINTMENT_MESSAGE_KINDS,
  type AppointmentMessageKind,
  type MessageChannel,
  type MessageKind,
} from '@consultorio/contracts';

/**
 * The channel policy of notifications (spec "Channels and purposes", "Opt-out and consent"; design
 * 5.2). It is pure: it answers "which channels may carry this message to this patient, in what
 * order", and says why each other channel was left out. Nothing here reads the database.
 *
 * - WhatsApp only for the messages of an appointment (reminder, confirmation, waitlist offer), and
 *   only with a recorded opt-in. Every other kind (codes, invitations, resets, notices, consent
 *   requests, invoices) is email only, whatever the patient has opted in to.
 * - An opt-out on a channel excludes it. Email needs no opt-in: the absence of an opt-out is the
 *   only gate (reminders are service communication, D10).
 * - A contact that is missing, or that failed for good and was not corrected, is skipped.
 * - The order is the fallback order: WhatsApp first, then email.
 */

/** Everything the policy knows about one patient. Addresses are only checked for presence. */
export interface ChannelFacts {
  email: string | null;
  phone: string | null;
  /** What the latest recorded event says. Email needs no opt-in: `default` is "not opted out". */
  emailPreference: 'default' | 'opted_out';
  /** `none` means the patient never opted in: WhatsApp stays unused. */
  whatsappPreference: 'none' | 'opted_in' | 'opted_out';
  emailUnreachable: boolean;
  whatsappUnreachable: boolean;
}

export interface ChannelOptions {
  /** The organization's WhatsApp switch AND an adapter that can send. */
  whatsappEnabled: boolean;
  /** False when the professional's quota is spent and the plan has no overage. */
  whatsappQuotaAvailable: boolean;
}

export type SkipReason =
  'no_opt_in' | 'opted_out' | 'no_contact' | 'unreachable' | 'integration_off' | 'quota';

export interface ChannelDecision {
  /** In fallback order. Empty when the patient cannot be reached automatically. */
  channels: MessageChannel[];
  skipped: { channel: MessageChannel; reason: SkipReason }[];
}

export function isAppointmentKind(kind: MessageKind): kind is AppointmentMessageKind {
  return APPOINTMENT_MESSAGE_KINDS.some((appointmentKind) => appointmentKind === kind);
}

function whatsappVerdict(facts: ChannelFacts, options: ChannelOptions): SkipReason | null {
  if (facts.whatsappPreference === 'opted_out') return 'opted_out';
  if (facts.whatsappPreference !== 'opted_in') return 'no_opt_in';
  if (!options.whatsappEnabled) return 'integration_off';
  if (facts.phone === null) return 'no_contact';
  if (facts.whatsappUnreachable) return 'unreachable';
  if (!options.whatsappQuotaAvailable) return 'quota';
  return null;
}

function emailVerdict(facts: ChannelFacts): SkipReason | null {
  if (facts.emailPreference === 'opted_out') return 'opted_out';
  if (facts.email === null) return 'no_contact';
  if (facts.emailUnreachable) return 'unreachable';
  return null;
}

export function selectChannels(
  kind: MessageKind,
  facts: ChannelFacts,
  options: ChannelOptions,
): ChannelDecision {
  const channels: MessageChannel[] = [];
  const skipped: ChannelDecision['skipped'] = [];

  // A kind that never uses WhatsApp does not report it as skipped: it was never a candidate.
  if (isAppointmentKind(kind)) {
    const reason = whatsappVerdict(facts, options);
    if (reason === null) channels.push('whatsapp');
    else skipped.push({ channel: 'whatsapp', reason });
  }

  const emailReason = emailVerdict(facts);
  if (emailReason === null) channels.push('email');
  else skipped.push({ channel: 'email', reason: emailReason });

  return { channels, skipped };
}
