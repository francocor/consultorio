import type { HolidayDto } from '@consultorio/contracts';

export interface CatalogHoliday {
  date: string;
  name: string;
  kind: 'national' | 'bridge';
}

export interface OrganizationDayOff {
  id: string;
  day: string;
  name: string;
  locationId: string | null;
}

/**
 * The holiday calendar of an organization: the country catalog plus the days the organization
 * adds on top (country-rules-ar, "Holiday catalog"). The catalog is never altered by the
 * organization. Sorted by date, then catalog entries before the organization's own.
 */
export function mergeHolidays(
  catalog: readonly CatalogHoliday[],
  daysOff: readonly OrganizationDayOff[],
): HolidayDto[] {
  const merged: HolidayDto[] = [
    ...catalog.map((holiday): HolidayDto => ({
      day: holiday.date,
      name: holiday.name,
      source: holiday.kind,
      locationId: null,
      dayOffId: null,
    })),
    ...daysOff.map((dayOff): HolidayDto => ({
      day: dayOff.day,
      name: dayOff.name,
      source: 'organization',
      locationId: dayOff.locationId,
      dayOffId: dayOff.id,
    })),
  ];
  const rank = (holiday: HolidayDto) => (holiday.source === 'organization' ? 1 : 0);
  return merged.sort(
    (a, b) => a.day.localeCompare(b.day) || rank(a) - rank(b) || a.name.localeCompare(b.name),
  );
}

/**
 * Is this local date closed at this location? National holidays and organization-wide days off
 * close every location; a day off limited to a location closes only that one.
 */
export function isClosedDay(
  holidays: readonly HolidayDto[],
  date: string,
  locationId: string,
): HolidayDto | null {
  return (
    holidays.find(
      (holiday) =>
        holiday.day === date && (holiday.locationId === null || holiday.locationId === locationId),
    ) ?? null
  );
}
