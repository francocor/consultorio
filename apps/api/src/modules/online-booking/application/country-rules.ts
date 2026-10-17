import type { Result } from '@consultorio/contracts';

import { getCountryPack, type CatalogReader } from '../../../platform/country/country-pack.js';

/**
 * The rules of the organization's country that the public form needs: how a document looks, the
 * age of majority and the data-processing consent text. They are pure, so the pack is built with an
 * empty catalog reader (holidays and payers are never asked here).
 */
const NO_CATALOGS: CatalogReader = {
  holidays: () => Promise.resolve([]),
  payers: () => Promise.resolve([]),
};

export interface CountryRules {
  validateDocument(type: string, value: string): Result<{ type: string; number: string }>;
  majorityAge: number;
  consent: { textKey: string; version: string };
}

/** The rules of a country, or null when the country is not supported (the form stays closed). */
export function countryRulesFor(country: string): CountryRules | null {
  const pack = getCountryPack(country, NO_CATALOGS);
  if (!pack.ok) return null;
  const { value } = pack;
  return {
    validateDocument: (type, number) => value.validateDocument(type, number),
    majorityAge: value.majorityAge,
    consent: {
      textKey: value.personalData.dataProcessingConsent.textKey,
      version: value.personalData.dataProcessingConsent.version,
    },
  };
}
