import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { DateTime } from 'luxon';

import type { AuditActor } from '../../../platform/audit/writer.js';

/** Who acts, for the audit entry and for the columns that remember the author. */
export type InvoicingActor = AuditActor & { userId: string };

/** The organization of the transaction, for the inserts (row level security checks it again). */
export const CURRENT_TENANT = sql`current_setting('app.tenant_id')::uuid`;

export const UNIQUE_VIOLATION = '23505';
export const CHECK_VIOLATION = '23514';
/** `lock_timeout` ran out: another transaction holds the row we need. */
export const LOCK_NOT_AVAILABLE = '55P03';

/** The SQLSTATE a driver error carries, if it is one. */
export function sqlState(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

/** The name of the constraint a driver error is about, if it names one. */
export function constraintOf(error: unknown): string | undefined {
  const cause = (error as { cause?: { constraint?: unknown } } | null)?.cause;
  return typeof cause?.constraint === 'string' ? cause.constraint : undefined;
}

/**
 * A fingerprint of what a submission asked for. The same key with another request is a mistake of
 * the client (a key reused), not a replay.
 */
export function hashOf(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Today in a time zone, as `YYYY-MM-DD`: the date printed on a voucher. */
export function todayIn(now: Date, timeZone: string): string {
  return DateTime.fromJSDate(now, { zone: timeZone }).toISODate() ?? now.toISOString().slice(0, 10);
}

/** The full name of a person as an invoice prints it ("Given Family"). */
export function fullName(person: { givenNames: string; familyName: string }): string {
  return `${person.givenNames} ${person.familyName}`.replace(/\s+/g, ' ').trim();
}
