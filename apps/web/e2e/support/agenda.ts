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
