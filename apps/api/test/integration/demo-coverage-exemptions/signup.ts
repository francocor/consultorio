/**
 * Tenant tables of the signup that the demo seed leaves empty on purpose, until the demo of Stage 6
 * (S6.12) decides what to show. A demonstration organization is created by the operator, never by a
 * signup, so it has no pending signup and no acceptance record of its own.
 */
export const exemptions: Record<string, string> = {
  signup_pending:
    'A signup waiting for its link: it exists only for an organization that was never confirmed, and a demonstration organization is created by the operator, not by a signup.',
  terms_acceptance:
    'The acceptance of the terms is written when the owner of a self-service signup verifies the address; a demonstration organization has no signup.',
};
