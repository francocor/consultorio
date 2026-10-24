import { tenant } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import { dayInZone, timeZoneOfCountry } from './country.js';

/**
 * The day it is in the organization (its country's zone), `YYYY-MM-DD`, from the clock of the
 * application. A representative link is in force while its review day is still ahead of it.
 */
export async function organizationToday(tx: Tx, now: Date): Promise<string> {
  const [row] = await tx.select({ country: tenant.country }).from(tenant);
  return dayInZone(timeZoneOfCountry(row?.country ?? 'AR'), now);
}

/**
 * Whether a link still gives access on `today`: it has no review day (a self link, or one the adult
 * authorized), or the day has not come (JD-S5 R1-S5-7). The daily job only records the suspension;
 * the access is refused here from the day on, whether or not the job has run. The database repeats
 * the rule in the functions that read what a policy hides from the portal.
 */
export function linkInForce(link: { majorityReviewOn: string | null }, today: string): boolean {
  return link.majorityReviewOn === null || link.majorityReviewOn > today;
}
