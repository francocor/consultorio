/**
 * Tables of the waitlist that the demo organization does not fill yet. The Stage 3 seed slice
 * (S3.16) seeds them and deletes this file. Each entry says why the table is empty until then.
 */
export const exemptions: Record<string, string> = {
  waitlist_entry: 'S3.16 seeds the entries of the demo organization waitlist.',
  waitlist_offer: 'S3.16 seeds an open offer and a closed one with the entries of the demo.',
  waitlist_call: 'S3.16 seeds the freed slots that reception is shown to fill by phone.',
};
