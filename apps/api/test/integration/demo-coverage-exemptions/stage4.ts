/**
 * Tables of Stage 4 that the demo seed leaves empty on purpose. Everything else of billing and
 * invoicing is seeded (`db/seed/demo/stage4`).
 */
export const exemptions: Record<string, string> = {
  export_request:
    'Made when somebody asks for an export, and built by the worker; the demo seed asks for none, so the exports screen shows its empty state first.',
  fiscal_credential:
    'A certificate is never part of a demo: the demo organization issues through the in-memory fake and holds no credential.',
  invoice_stray_voucher:
    'Written only when an invoice is replaced by hand without knowing whether it was issued, or when a voucher arrives for a closed invoice; the demo seed does neither.',
};
