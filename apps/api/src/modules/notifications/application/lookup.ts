import { sql, type SQL } from 'drizzle-orm';

import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';

/** A tenant id that matches no row: the transaction has a context but belongs to nobody. */
const NO_TENANT = '00000000-0000-0000-0000-000000000000';

/**
 * Which organization a webhook event is about. The provider's request carries no tenant, and the
 * tenant never comes from what it says: it comes from OUR record of what we sent. Two
 * `SECURITY DEFINER` functions (migration 0392) answer, and what they return is the tenant id and
 * nothing else: no message row, no patient, no address ever leaves the database through them.
 */

async function tenantIds(withTenant: WithTenant, query: SQL): Promise<string[]> {
  return withTenant({ tenantId: NO_TENANT, userId: SYSTEM_USER_ID }, async (tx) => {
    const rows = await tx.execute<{ tenant_id: string }>(query);
    return rows.rows.map((row) => row.tenant_id);
  });
}

/** The organization that sent the message the provider calls this. At most one. */
export function tenantsByProviderMessageId(
  withTenant: WithTenant,
  providerMessageId: string,
): Promise<string[]> {
  return tenantIds(
    withTenant,
    sql`select tenant_id from app.message_tenants_by_provider_id(${providerMessageId}::text)`,
  );
}

/** The organization of the message a reply quotes, only when it went to the number of the reply. */
export function tenantsByReplyContext(
  withTenant: WithTenant,
  providerMessageId: string,
  recipientHash: string,
): Promise<string[]> {
  return tenantIds(
    withTenant,
    sql`select tenant_id from app.whatsapp_reply_context_tenants(${providerMessageId}::text, ${recipientHash}::text)`,
  );
}

/**
 * The organizations that wrote to a number held under any of several hashes (the keyed one and the
 * unsalted one the log used before the pepper), over WhatsApp since `since` (null: ever), the one
 * that wrote last under ANY of them first, at most `limit`. The order is decided in the database,
 * before the limit: merging one answer per hash would lose it.
 */
export function tenantsByRecipientHashes(
  withTenant: WithTenant,
  recipientHashes: readonly string[],
  options: { since: Date | null; limit: number },
): Promise<string[]> {
  const since =
    options.since === null
      ? sql`'-infinity'::timestamptz`
      : sql`${options.since.toISOString()}::timestamptz`;
  const hashes = sql.join(
    recipientHashes.map((hash) => sql`${hash}::text`),
    sql`, `,
  );
  return tenantIds(
    withTenant,
    sql`select tenant_id from app.whatsapp_reply_tenants_any(array[${hashes}]::text[], ${since}, ${options.limit}::integer)`,
  );
}
