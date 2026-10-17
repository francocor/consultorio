import type { Page } from '@playwright/test';

import { urlOf, type Organization } from './stack.js';

const DAY_MS = 86_400_000;
const ZONE = 'America/Argentina/Buenos_Aires';

const localDate = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date(iso));

interface FeedEntry {
  startsAt: string;
  status: string;
}

/** What the signed-in person's agenda holds around today, as the API reports it. */
export async function feedAroundToday(
  page: Page,
  organization: Organization = 'aillu',
): Promise<FeedEntry[]> {
  const from = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const to = new Date(Date.now() + 14 * DAY_MS).toISOString();
  const response = await page.request.get(
    urlOf(organization, `/api/appointments?from=${from}&to=${to}`),
  );
  const body = (await response.json()) as { appointments: FeedEntry[] };
  return body.appointments;
}

/**
 * A day of the demo agenda with several appointments, so a spec does not depend on the weekday it
 * runs on (the demo seeds around "now": weekends have no working hours).
 */
export async function busyDay(
  page: Page,
  options: { future?: boolean } = {},
  organization: Organization = 'aillu',
): Promise<string> {
  const today = localDate(new Date().toISOString());
  const counts = new Map<string, number>();
  for (const entry of await feedAroundToday(page, organization)) {
    if (entry.status === 'cancelled') continue;
    const day = localDate(entry.startsAt);
    if (options.future === true && day < today) continue;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  const best = ranked[0];
  if (!best) throw new Error('The demo agenda has no appointments around today');
  return best[0];
}

export interface FreeSlot {
  startsAt: string;
  endsAt: string;
  locationId: string;
  date: string;
}

export interface Bookable {
  professionalId: string;
  professionalName: string;
  typeId: string;
  typeName: string;
  slots: FreeSlot[];
}

const plusDays = (iso: string, days: number) =>
  localDate(new Date(new Date(iso).getTime() + days * DAY_MS).toISOString());

/**
 * A professional of the demo with free times in the next four weeks, found through the API the
 * screens use, so a spec never depends on the weekday it runs on or on what other specs booked.
 * The demo seeds about three weeks of agenda; further out the days are free, so a long-lived stack
 * that earlier runs have filled still has room.
 */
export async function bookableProfessional(
  page: Page,
  options: {
    specialty?: string;
    typeName?: string;
    organization?: Organization;
    /** Where reception works: a free time elsewhere could not be booked by the spec. */
    locationNames?: readonly string[];
  } = {},
): Promise<Bookable> {
  const {
    specialty = 'Cardiología',
    typeName = 'Primera consulta',
    organization = 'aillu',
    locationNames = ['Sede Central', 'Consultorios Norte'],
  } = options;
  const staff = (await (await page.request.get(urlOf(organization, '/api/staff'))).json()) as {
    staff: {
      displayName: string | null;
      professional: { id: string; specialties: string[] } | null;
    }[];
  };
  const member = staff.staff.find((entry) => entry.professional?.specialties.includes(specialty));
  if (!member?.professional) throw new Error(`No ${specialty} professional in the demo`);
  const types = (await (
    await page.request.get(urlOf(organization, '/api/appointment-types'))
  ).json()) as {
    types: { id: string; name: string }[];
  };
  const type = types.types.find((entry) => entry.name === typeName);
  if (!type) throw new Error(`No "${typeName}" appointment type in the demo`);
  const locations = (await (
    await page.request.get(urlOf(organization, '/api/locations'))
  ).json()) as { locations: { id: string; name: string }[] };
  const allowed = new Set(
    locations.locations
      .filter((entry) => locationNames.includes(entry.name))
      .map((entry) => entry.id),
  );

  const nowIso = new Date().toISOString();
  const query = new URLSearchParams({
    professionalId: member.professional.id,
    typeId: type.id,
    from: localDate(nowIso),
    to: plusDays(nowIso, 27),
  });
  const availability = (await (
    await page.request.get(urlOf(organization, `/api/availability?${query.toString()}`))
  ).json()) as { slots: FreeSlot[] };
  return {
    professionalId: member.professional.id,
    professionalName: member.displayName ?? specialty,
    typeId: type.id,
    typeName: type.name,
    slots: availability.slots.filter(
      (slot) =>
        allowed.has(slot.locationId) && new Date(slot.startsAt).getTime() > Date.now() + 3_600_000,
    ),
  };
}

/** The wall-clock time of an instant in the demo's zone, as the screens write it. */
export const clockTime = (iso: string) =>
  new Intl.DateTimeFormat('es-AR', {
    timeZone: ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
