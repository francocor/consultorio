import type { WaitlistChannel, WaitlistManualReason } from '@consultorio/contracts';

/** What is known about one channel of a patient. */
export interface ChannelReach {
  /** The patient has an address for it and may be written to on it. */
  usable: boolean;
  /** The patient refused it (an opt-out is the latest thing they said about it). */
  optedOut: boolean;
}

export type Reach = Record<WaitlistChannel, ChannelReach>;

/**
 * Why automated offers are not sent for an entry, if they are not (waitlist, "Joining the
 * waitlist"): the patient did not agree to receive offers, or none of the channels the entry chose
 * reaches them. Reception calls those patients. Null means offers may be sent.
 *
 * The agreement comes first: without it no channel matters. When no chosen channel reaches the
 * patient, a refusal on any of them is the reason worth telling reception about.
 */
export function manualContactReason(input: {
  offersOptIn: boolean;
  channels: readonly WaitlistChannel[];
  reach: Reach;
}): WaitlistManualReason | null {
  if (!input.offersOptIn) return 'no_offers_opt_in';
  if (input.channels.some((channel) => input.reach[channel].usable)) return null;
  return input.channels.some((channel) => input.reach[channel].optedOut)
    ? 'patient_opted_out'
    : 'no_reachable_channel';
}
