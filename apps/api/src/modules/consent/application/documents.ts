import { tenant } from '../../../db/schema/tenant.js';
import { getCountryPack, type CatalogReader } from '../../../platform/country/country-pack.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { readOrganizationName } from '../../tenancy/index.js';

import { patientSigningFacts } from './patient-facts.js';
import { renderSignedConsent } from './render-signed.js';
import type { SignedRecord } from './signed-record.js';

const NO_CATALOGS: CatalogReader = {
  holidays: () => Promise.resolve([]),
  payers: () => Promise.resolve([]),
};

const FALLBACK_TIME_ZONE = 'America/Argentina/Buenos_Aires';

/** The time zone the dates of the printable record are written in: the organization's country. */
async function organizationTimeZone(tx: Tx): Promise<string> {
  const [row] = await tx.select({ country: tenant.country }).from(tenant);
  const pack = getCountryPack(row?.country ?? 'AR', NO_CATALOGS);
  return pack.ok ? pack.value.defaults.timeZone : FALLBACK_TIME_ZONE;
}

export interface SignedDocument {
  bytes: Buffer;
  fileName: string;
}

/** Renders the printable record of an opened signed consent (see `renderSignedConsent`). */
export async function renderSignedDocument(
  tx: Tx,
  record: SignedRecord,
  now: Date,
): Promise<SignedDocument> {
  const facts = await patientSigningFacts(tx, record.request.patientId, now);
  const bytes = await renderSignedConsent(record, {
    organizationName: await readOrganizationName(tx),
    patientName: facts.name,
    timeZone: await organizationTimeZone(tx),
  });
  return { bytes, fileName: `consentimiento-${record.request.id}.pdf` };
}
