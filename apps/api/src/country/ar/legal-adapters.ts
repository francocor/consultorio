import type { LegalAdapterDeclaration } from '../../platform/country/country-pack.js';

/**
 * The legal integrations Argentina requires, declared so dependent features can degrade without
 * blocking unrelated work. Behavior arrives with Stage 4 (AFIP/ARCA) and Stage 5 (e-prescription,
 * Ley 27.553). Until then `implemented` is false and the pack exposes no adapter instance.
 */
export const AR_LEGAL_ADAPTERS: readonly LegalAdapterDeclaration[] = [
  { port: 'InvoiceIssuer', provider: 'afip-wsfe', implemented: false },
  { port: 'PrescriptionProvider', provider: 'e-rx', implemented: false },
];
