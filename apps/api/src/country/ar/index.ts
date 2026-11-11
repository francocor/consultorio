import {
  fail,
  ok,
  validateCuit,
  validateMatricula,
  validateNationalId,
  validatePassport,
} from '@consultorio/contracts';

import type { CatalogReader, CountryPack } from '../../platform/country/country-pack.js';

import { AR_INVOICE_RULES } from './afip/index.js';
import { AR_DEFAULTS } from './defaults.js';
import { AR_LEGAL_ADAPTERS } from './legal-adapters.js';
import { AR_PERSONAL_DATA } from './personal-data.js';
import { AR_RETENTION } from './retention.js';

const COUNTRY = 'AR';

/**
 * Builds the Argentina pack. Validators are the pure functions shared with the web app
 * (`@consultorio/contracts`); holidays and payers come from the platform catalogs.
 *
 * Argentina is the only country there is (owner decision: the product is Argentina-first), and three
 * rules of the DATABASE assume it: the age of majority is 18 and the day is the one of Buenos Aires in
 * `app.majority_review_date`, `app.patient_birth_date_changed` (the trigger that moves the review day
 * of a representative when a birth date is corrected) and `app.portal_today` (migrations 0591 and
 * 0592). The application reads the age and the zone from this pack (`majorityAge`, `timeZone`); the
 * trigger and the two functions do not. A second country pack must turn those three into data of the
 * pack (a column or a setting of the organization) before the first organization of that country.
 */
export function createArPack(catalogs: CatalogReader): CountryPack {
  return {
    code: COUNTRY,
    defaults: AR_DEFAULTS,
    validateNationalId,
    validateDocument(type, value) {
      switch (type) {
        case 'dni': {
          const checked = validateNationalId(value);
          return checked.ok ? ok({ type, number: checked.value }) : checked;
        }
        case 'passport': {
          const checked = validatePassport(value);
          return checked.ok ? ok({ type, number: checked.value }) : checked;
        }
        default:
          return fail('country.ar.document.unknown_type');
      }
    },
    // Ley 26.579: legal age is 18.
    majorityAge: 18,
    validateTaxId: validateCuit,
    validateMatricula,
    holidays: (year) => catalogs.holidays(COUNTRY, year),
    payerCatalog: () => catalogs.payers(COUNTRY),
    personalData: AR_PERSONAL_DATA,
    retention: AR_RETENTION,
    legalAdapters: AR_LEGAL_ADAPTERS,
    invoiceRules: AR_INVOICE_RULES,
  };
}
