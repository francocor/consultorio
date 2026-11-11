import {
  getCountryPack,
  type CatalogReader,
  type CountryPack,
} from '../../../platform/country/country-pack.js';
import { AppError } from '../../../platform/http/problem.js';

/**
 * The invoice rules and the CUIT check of the organization's country. They are pure, so the pack
 * is built with an empty catalog reader (holidays and payers are never asked here). The rules are
 * reached only through the pack registry, never by importing `country/ar`.
 */
const NO_CATALOGS: CatalogReader = {
  holidays: () => Promise.resolve([]),
  payers: () => Promise.resolve([]),
};

/** The pack of a country; an unsupported country is refused with the catalogued error. */
export function packFor(country: string): CountryPack {
  const pack = getCountryPack(country, NO_CATALOGS);
  if (!pack.ok) throw new AppError('unsupported_country');
  return pack.value;
}
