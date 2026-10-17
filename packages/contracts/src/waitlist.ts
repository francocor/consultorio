import { z } from 'zod';

/**
 * Contracts of the waitlist module (entries, offers of freed slots). This file holds what is
 * certain from the design and the spec; the waitlist track (S3.11 to S3.13) adds its request and
 * response shapes below, in this file only.
 */

export const WAITLIST_ENTRY_STATUSES = ['active', 'paused', 'offered', 'closed'] as const;
export type WaitlistEntryStatus = (typeof WAITLIST_ENTRY_STATUSES)[number];

export const WAITLIST_OFFER_STATUSES = [
  'open',
  'accepted',
  'declined',
  'expired',
  'invalidated',
] as const;
export type WaitlistOfferStatus = (typeof WAITLIST_OFFER_STATUSES)[number];

export const WAITLIST_CLOSE_REASONS = [
  'fulfilled',
  'expired',
  'cancelled',
  'patient_opted_out',
] as const;
export type WaitlistCloseReason = (typeof WAITLIST_CLOSE_REASONS)[number];

/** Audit actions of the waitlist. They are registered in the shared catalogue. */
export const WAITLIST_AUDIT_ACTIONS = [
  'waitlist.entry.created',
  'waitlist.entry.updated',
  'waitlist.entry.closed',
  'waitlist.offer.created',
  'waitlist.offer.accepted',
  'waitlist.offer.declined',
  'waitlist.offer.expired',
  'waitlist.priority.overridden',
] as const;

/** The `waitlist` section of the organization settings (spec defaults). */
export const WaitlistSettings = z.strictObject({
  /** An entry becomes inactive after this many days. */
  entryExpiryDays: z.int().min(1).max(365),
  /** How long an offer stays open (shortened when the slot is near). */
  offerWindowMinutes: z.int().min(5).max(240),
  /** A slot starting sooner than this is not offered through automated messages. */
  minOfferLeadMinutes: z
    .int()
    .min(0)
    .max(24 * 60),
  /** Most active entries one patient may hold. */
  maxActiveEntries: z.int().min(1).max(20),
});
export type WaitlistSettings = z.infer<typeof WaitlistSettings>;

export const DEFAULT_WAITLIST_SETTINGS: WaitlistSettings = {
  entryExpiryDays: 60,
  offerWindowMinutes: 30,
  minOfferLeadMinutes: 60,
  maxActiveEntries: 5,
};
