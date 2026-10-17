/**
 * Tables of online booking that the demo organization leaves empty on purpose. The booking links
 * are seeded (Stage 3 demo seed); what remains is transient by design.
 */
export const exemptions: Record<string, string> = {
  booking_submission:
    'An unverified form is deleted after 24 hours and a verified one keeps only its consent evidence; the demo seed writes the bookings themselves, so there are none to show.',
  public_hold:
    'A public hold lives ten minutes and becomes the appointment; the demo seed books the appointments directly.',
  otp_challenge: 'Transient by design: a one-time code lives ten minutes.',
};
