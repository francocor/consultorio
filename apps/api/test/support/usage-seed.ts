import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { TestSession } from './session.js';
import type { SubscriptionOrganization } from './subscription-world.js';

/**
 * Arranges the metering of an organization for the tests of the subscriptions: the id of the
 * professional of a signed-in user, the days they were active, and WhatsApp messages the provider
 * accepted (or reserved, or released). Everything is written as the system, in the organization's own
 * tenant context, the way the jobs and the notifications module write it.
 */

/** The professional row of a member who has a profile (see `SubscriptionOrganization.professional`). */
export async function professionalIdOf(
  org: SubscriptionOrganization,
  session: TestSession,
): Promise<string> {
  const [row] = await org.run(
    sql`select id from professional where membership_id = ${session.user.membershipId}`,
  );
  const id = row?.['id'];
  if (typeof id !== 'string') throw new Error('the member has no professional profile');
  return id;
}

/** The days (`YYYY-MM-DD`) a professional was active, as the daily snapshot would have recorded them. */
export async function seedActiveDays(
  org: SubscriptionOrganization,
  professionalId: string,
  days: readonly string[],
): Promise<void> {
  for (const day of days) {
    await org.run(
      sql`insert into usage_record (tenant_id, kind, professional_id, period, day, quantity)
            values (current_setting('app.tenant_id')::uuid, 'active_professional_day',
                    ${professionalId}, ${day.slice(0, 7)}, ${day}, 1)
            on conflict do nothing`,
    );
  }
}

export interface SeedMessages {
  /** The billing period (`YYYY-MM`) the events are counted in. */
  period: string;
  /** The instant they were accepted. Defaults to the middle of the period. */
  at?: Date;
  /** `accepted` (confirmed by the provider), `reserved` (waiting to go) or `released`. */
  state?: 'accepted' | 'reserved' | 'released';
}

/** `count` WhatsApp messages for a professional, each with its usage event. Returns the event ids, oldest first. */
export async function seedMessages(
  org: SubscriptionOrganization,
  professionalId: string,
  count: number,
  options: SeedMessages,
): Promise<string[]> {
  if (count === 0) return [];
  const at = options.at ?? new Date(`${options.period}-15T15:00:00.000Z`);
  const state = options.state ?? 'accepted';
  const tag = randomUUID().slice(0, 8);
  const rows = await org.run(
    sql`with patient_row as (
          insert into patient (tenant_id, family_name, given_names, birth_date)
          values (current_setting('app.tenant_id')::uuid, 'Apellido', 'Nombre', '1990-01-01')
          returning id
        ), message_rows as (
          insert into message (tenant_id, patient_id, professional_id, kind, channel, dedupe_key, send_at, status)
          select current_setting('app.tenant_id')::uuid, patient_row.id, ${professionalId},
                 'reminder', 'whatsapp', ${`seed-${tag}-`} || n, ${at.toISOString()}::timestamptz,
                 ${state === 'reserved' ? 'queued' : 'sent'}
            from patient_row, generate_series(1, ${count}) n
          returning id, dedupe_key
        )
        insert into whatsapp_usage_event (tenant_id, message_id, professional_id, period, counted_at,
                                          confirmed_at, released_at)
        select current_setting('app.tenant_id')::uuid, id, ${professionalId}, ${options.period},
               ${at.toISOString()}::timestamptz + (substring(dedupe_key from '[0-9]+$')::int * interval '1 second'),
               ${state === 'reserved' ? null : at.toISOString()}::timestamptz,
               ${state === 'released' ? at.toISOString() : null}::timestamptz
          from message_rows
        returning id, counted_at`,
  );
  return rows
    .map((row) => ({ id: String(row['id']), at: new Date(String(row['counted_at'])) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id))
    .map((row) => row.id);
}

/** Messages that are prepared and waiting, with no usage event yet: what a reservation is made for. */
export async function seedBareMessages(
  org: SubscriptionOrganization,
  professionalId: string,
  count: number,
): Promise<string[]> {
  const tag = randomUUID().slice(0, 8);
  const rows = await org.run(
    sql`with patient_row as (
          insert into patient (tenant_id, family_name, given_names, birth_date)
          values (current_setting('app.tenant_id')::uuid, 'Apellido', 'Nombre', '1990-01-01')
          returning id
        )
        insert into message (tenant_id, patient_id, professional_id, kind, channel, dedupe_key, send_at, status)
        select current_setting('app.tenant_id')::uuid, patient_row.id, ${professionalId},
               'reminder', 'whatsapp', ${`bare-${tag}-`} || n, now(), 'queued'
          from patient_row, generate_series(1, ${count}) n
        returning id`,
  );
  return rows.map((row) => String(row['id']));
}
