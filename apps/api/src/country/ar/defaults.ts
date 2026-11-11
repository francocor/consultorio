import type { CountryDefaults } from '../../platform/country/country-pack.js';

/** Defaults for a new Argentine organization and location (locale, money, dates, time zone). */
export const AR_DEFAULTS: CountryDefaults = {
  locale: 'es-AR',
  currency: 'ARS',
  currencyDecimals: 2,
  timeZone: 'America/Argentina/Buenos_Aires',
  dateFormat: 'dd/MM/yyyy',
  decimalSeparator: ',',
  thousandsSeparator: '.',
};
