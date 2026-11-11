import { sql } from 'drizzle-orm';

import type { AuditActor } from '../../../platform/audit/writer.js';

/** Who acts, for the audit entry and for the columns that remember the author. */
export type BillingActor = AuditActor & { userId: string };

/** The organization of the transaction, for the inserts (row level security checks it again). */
export const CURRENT_TENANT = sql`current_setting('app.tenant_id')::uuid`;

export const UNIQUE_VIOLATION = '23505';
export const FOREIGN_KEY_VIOLATION = '23503';

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

/** `YYYY-MM-DD` of an instant in a time zone (the day the service is given, at the location). */
export function localDay(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  return parts;
}
