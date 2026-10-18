import { getCountryPack, type CatalogReader } from '../../../platform/country/country-pack.js';
import { AppError } from '../../../platform/http/problem.js';

/** Validating a tax id reads no catalog; the pack only needs something to hold. */
const NO_CATALOGS: CatalogReader = {
  holidays: () => Promise.resolve([]),
  payers: () => Promise.resolve([]),
};

/**
 * The tax id of a payer as the country of the organization writes it: digits and check digit
 * validated by the country pack (Argentina: CUIT, 11 digits with an assigned prefix and a correct
 * modulo-11 check digit), returned normalized (`30-70857833-0` becomes `30708578330`). A value the
 * pack refuses is a validation error on the field `cuit`.
 */
export function validTaxId(country: string, value: string): string {
  const pack = getCountryPack(country, NO_CATALOGS);
  if (!pack.ok) throw new AppError('unsupported_country');
  const checked = pack.value.validateTaxId(value);
  if (!checked.ok) {
    throw new AppError('validation_failed', [{ path: 'cuit', i18nKey: checked.error.i18nKey }]);
  }
  return checked.value;
}
