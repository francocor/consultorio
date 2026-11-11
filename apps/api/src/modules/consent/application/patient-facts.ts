import { eq } from 'drizzle-orm';

import { patient } from '../../../db/schema/patients.js';
import { tenant } from '../../../db/schema/tenant.js';
import { getCountryPack, type CatalogReader } from '../../../platform/country/country-pack.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { isMinor } from '../../patients/index.js';

/** The age of majority needs no catalog: the pack is built with an empty reader. */
const NO_CATALOGS: CatalogReader = {
  holidays: () => Promise.resolve([]),
  payers: () => Promise.resolve([]),
};

/** The age of majority of the country, 18 when the country has no pack (the safe, older age). */
function majorityAgeOf(country: string): number {
  const pack = getCountryPack(country, NO_CATALOGS);
  return pack.ok ? pack.value.majorityAge : 18;
}

export interface PatientSigningFacts {
  name: string;
  /** A minor never signs for themselves: a representative does (informed-consent, "Minors"). */
  minor: boolean;
}

/** What the signing of a consent needs to know about the patient. */
export async function patientSigningFacts(
  tx: Tx,
  patientId: string,
  now: Date,
): Promise<PatientSigningFacts> {
  const [row] = await tx
    .select({
      givenNames: patient.givenNames,
      familyName: patient.familyName,
      birthDate: patient.birthDate,
    })
    .from(patient)
    .where(eq(patient.id, patientId));
  if (!row) throw new AppError('not_found');
  const [organization] = await tx.select({ country: tenant.country }).from(tenant);
  const today = now.toISOString().slice(0, 10);
  return {
    name: `${row.givenNames} ${row.familyName}`,
    minor: isMinor(row.birthDate, today, majorityAgeOf(organization?.country ?? 'AR')),
  };
}
