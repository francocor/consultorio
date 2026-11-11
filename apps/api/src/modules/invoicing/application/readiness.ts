import type { InvoicingBlockReason, InvoicingReadinessDto } from '@consultorio/contracts';
import { asc, eq } from 'drizzle-orm';

import { fiscalCredential, fiscalProfile, pointOfSale } from '../../../db/schema/index.js';
import type { AdapterResolver } from '../../../main/adapter-resolver.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { credentialState } from '../domain/credential.js';

import { isSimulatedIssuer, issuerFor } from './issuer.js';
import { loadOrganization, type OrganizationFacts } from './settings.js';

export interface ReadinessDeps {
  adapters?: AdapterResolver | undefined;
  clock: () => Date;
}

/**
 * Whether invoices can be issued now, and if not why (e-invoicing-afip, "Fiscal configuration per
 * organization", "Fiscal credentials lifecycle" and "Read-only tenant and feature control"):
 *
 * - the organization switched e-invoicing on, and an issuer serves it;
 * - the fiscal profile exists and at least one point of sale is active;
 * - the certificate is not expired and is for the CUIT of the profile. A real issuer needs one; a
 *   simulator does not (but a certificate that is there and expired still blocks, so the screens
 *   tell the same story as in production).
 *
 * Disabling e-invoicing blocks NEW invoices only; existing ones stay readable.
 */
export async function invoicingReadiness(
  tx: Tx,
  deps: ReadinessDeps,
  organization?: OrganizationFacts,
): Promise<InvoicingReadinessDto> {
  const org = organization ?? (await loadOrganization(tx));
  const issuer = issuerFor(deps.adapters, { id: org.id, isDemo: org.isDemo });
  const simulated = isSimulatedIssuer(issuer);

  const [profile] = await tx.select().from(fiscalProfile);
  const points = await tx
    .select({ id: pointOfSale.id, active: pointOfSale.active })
    .from(pointOfSale)
    .orderBy(asc(pointOfSale.number));
  const [credential] = await tx
    .select()
    .from(fiscalCredential)
    .where(eq(fiscalCredential.active, true));

  const reasons: InvoicingBlockReason[] = [];
  if (!org.enabled) reasons.push('disabled');
  if (!issuer) reasons.push('issuer_unavailable');
  if (!profile) reasons.push('profile_missing');
  if (!points.some((point) => point.active)) reasons.push('point_of_sale_missing');

  if (credential && profile) {
    const state = credentialState({
      notBefore: credential.notBefore,
      notAfter: credential.notAfter,
      subjectCuit: credential.subjectCuit,
      profileCuit: profile.cuit,
      now: deps.clock(),
    });
    if (state === 'expired') reasons.push('credential_expired');
    if (state === 'invalid') reasons.push('credential_invalid');
  } else if (!credential && issuer && !simulated) {
    reasons.push('credential_missing');
  }

  return { available: reasons.length === 0, reasons, simulated };
}
