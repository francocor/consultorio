/**
 * Tables of the portal that the demo organization leaves empty until the Stage 5 demo seed (S5.12,
 * track C) gives the demo a patient with a portal account. Track C removes this file when it seeds
 * them.
 */
export const exemptions: Record<string, string> = {
  portal_identity: 'Seeded by the Stage 5 demo seed (S5.12).',
  portal_link: 'Seeded by the Stage 5 demo seed (S5.12).',
  portal_session:
    'A session lives 12 hours at most and is made by a sign-in; the demo seed signs nobody in.',
};
