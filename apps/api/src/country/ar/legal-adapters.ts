import type { LegalAdapterDeclaration } from '../../platform/country/country-pack.js';

/**
 * The legal integrations Argentina requires, declared so dependent features can degrade without
 * blocking unrelated work. `implemented` means the port has working adapters: the invoice issuer
 * has the in-memory fake and the local AFIP simulator (Stage 4); the real WSAA/WSFEv1 adapter
 * (`afip-wsfe`) is the deferred slice S4.D. The e-prescription provider arrives with Stage 5
 * (Ley 27.553). The pack exposes no adapter instance: adapters are chosen per organization by the
 * adapter resolver.
 */
export const AR_LEGAL_ADAPTERS: readonly LegalAdapterDeclaration[] = [
  { port: 'InvoiceIssuer', provider: 'afip-wsfe', implemented: true },
  { port: 'PrescriptionProvider', provider: 'e-rx', implemented: false },
];
