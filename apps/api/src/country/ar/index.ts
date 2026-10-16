import { validateCuit, validateMatricula, validateNationalId } from '@consultorio/contracts';

import type { CatalogReader, CountryPack } from '../../platform/country/country-pack.js';

import { AR_DEFAULTS } from './defaults.js';
import { AR_LEGAL_ADAPTERS } from './legal-adapters.js';
import { AR_PERSONAL_DATA } from './personal-data.js';
import { AR_RETENTION } from './retention.js';

const COUNTRY = 'AR';

/**
 * Builds the Argentina pack. Validators are the pure functions shared with the web app
 * (`@consultorio/contracts`); holidays and payers come from the platform catalogs.
 */
export function createArPack(catalogs: CatalogReader): CountryPack {
  return {
    code: COUNTRY,
    defaults: AR_DEFAULTS,
    validateNationalId,
    validateTaxId: validateCuit,
    validateMatricula,
    holidays: (year) => catalogs.holidays(COUNTRY, year),
    payerCatalog: () => catalogs.payers(COUNTRY),
    personalData: AR_PERSONAL_DATA,
    retention: AR_RETENTION,
    legalAdapters: AR_LEGAL_ADAPTERS,
  };
}
