import type { Result } from '@consultorio/contracts';

import { getCountryPack, type CatalogReader } from '../../../platform/country/country-pack.js';

/**
 * The rules of the organization's country that the portal needs: the age of majority (a
 * representative link is reviewed on that day) and how a document number looks (the registration
 * form asks for it). They are pure, so the pack is built with an empty catalog reader.
 */
const NO_CATALOGS: CatalogReader = {
  holidays: () => Promise.resolve([]),
  payers: () => Promise.resolve([]),
};

/** The age of majority of a country; 18 when the country is not one the product supports. */
export function majorityAgeOf(country: string): number {
  const pack = getCountryPack(country, NO_CATALOGS);
  return pack.ok ? pack.value.majorityAge : 18;
}

/** The zone a country's days are counted in; UTC when the country is not one the product supports. */
export function timeZoneOfCountry(country: string): string {
  const pack = getCountryPack(country, NO_CATALOGS);
  return pack.ok ? pack.value.defaults.timeZone : 'UTC';
}

/** The calendar day an instant is in a time zone, `YYYY-MM-DD`. */
export function dayInZone(timeZone: string, now: Date): string {
  // The Canadian English locale writes dates as year-month-day.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Checks and normalizes a document number the way the registry of the country does. */
export function normalizeDocument(
  country: string,
  type: string,
  number: string,
): Result<{ type: string; number: string }> | null {
  const pack = getCountryPack(country, NO_CATALOGS);
  return pack.ok ? pack.value.validateDocument(type, number) : null;
}
