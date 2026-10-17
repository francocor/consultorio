/**
 * Tables of online booking that the demo organization does not fill yet. The Stage 3 seed slice
 * (S3.16) seeds them and deletes this file. Each entry says why the table is empty until then.
 */
export const exemptions: Record<string, string> = {
  booking_link: 'S3.16 seeds the public booking links of the demo organization.',
  booking_submission:
    'Transient by design: an unverified form is deleted after 24 hours, so a demo has none to show.',
  otp_challenge: 'Transient by design: a one-time code lives ten minutes.',
};
