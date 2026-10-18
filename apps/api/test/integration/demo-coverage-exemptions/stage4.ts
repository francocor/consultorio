/**
 * Tables of Stage 4 that the demo seed leaves empty on purpose. Everything else of billing and
 * invoicing is seeded (`db/seed/demo/stage4`).
 */
export const exemptions: Record<string, string> = {
  export_request:
    'Made when somebody asks for an export, and built by the worker; the demo seed asks for none, so the exports screen shows its empty state first.',
  fiscal_credential:
    'A certificate is never part of a demo: the demo organization issues through the in-memory fake and holds no credential.',
};
