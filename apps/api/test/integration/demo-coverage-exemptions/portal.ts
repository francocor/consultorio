/**
 * Tables of the portal that the demo organization leaves empty. The identities, the links and the
 * shared document are seeded by the Stage 5 demo seed (`db/seed/demo/stage5`).
 */
export const exemptions: Record<string, string> = {
  portal_session:
    'A session lives 12 hours at most and is made by a sign-in with an emailed code; the demo seed signs nobody in, and the sign-in code is read in the provider console (the demo outbox).',
};
