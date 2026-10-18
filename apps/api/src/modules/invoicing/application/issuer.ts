import type { InvoiceIssuer } from '@consultorio/contracts';

import type { AdapterResolver, TenantRef } from '../../../main/adapter-resolver.js';

/**
 * An issuer that only pretends to reach the tax authority: the in-memory fake and the local AFIP
 * simulator. Both carry `simulated: true`, and that is how the module knows to say "simulated" on
 * every screen, to force homologation and to not ask for a certificate (task 4.36).
 */
export interface SimulatedInvoiceIssuer extends InvoiceIssuer {
  readonly simulated: true;
}

export function isSimulatedIssuer(issuer: InvoiceIssuer | undefined): boolean {
  return issuer !== undefined && (issuer as { simulated?: unknown }).simulated === true;
}

/**
 * The issuer that serves this organization: the simulator, the real one, or none (`AFIP_PROVIDER=off`
 * or no resolver at all). A demo organization only ever gets the fake.
 */
export function issuerFor(
  adapters: AdapterResolver | undefined,
  tenant: TenantRef,
): InvoiceIssuer | undefined {
  return adapters?.forTenant(tenant, 'invoiceIssuer');
}
