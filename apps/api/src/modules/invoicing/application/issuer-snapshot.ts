import type { FiscalProfileRow } from '../../../db/schema/index.js';
import { fiscalProfile } from '../../../db/schema/index.js';
import type { IssuerSnapshot } from '../../../db/schema/invoicing.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

export type { IssuerSnapshot } from '../../../db/schema/invoicing.js';

/**
 * Who issues the vouchers, as the fiscal profile says now. An invoice keeps this when it is
 * requested (`invoice.issuer_snapshot`), so a later edit of the profile (a new CUIT, a new address)
 * never changes a voucher that was requested, the fingerprint the authority knows it by, or the PDF
 * (JD-S4 R1-C7).
 */
export function snapshotOfProfile(profile: FiscalProfileRow): IssuerSnapshot {
  return {
    cuit: profile.cuit,
    businessName: profile.businessName,
    taxCondition: profile.taxCondition,
    address: profile.address,
    activityStartedOn: profile.activityStartedOn,
  };
}

/** The issuer of the organization now, or null when it has no fiscal profile. */
export async function currentIssuer(tx: Tx): Promise<IssuerSnapshot | null> {
  const [profile] = await tx.select().from(fiscalProfile);
  return profile ? snapshotOfProfile(profile) : null;
}
