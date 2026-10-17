import { sql } from 'drizzle-orm';

import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';

/** A tenant id that matches no row: the transaction has a context but belongs to nobody. */
const NO_TENANT = '00000000-0000-0000-0000-000000000000';

/**
 * Which organization a webhook event is about. The provider's request carries no tenant, and the
 * tenant never comes from what it says: it comes from OUR record of what we sent. These lookups
 * open a transaction that belongs to no organization and declare, in a transaction-local setting,
 * the one provider id (or the one sender) to look for; two read-only policies on `message`
 * (migration 0322) let exactly those rows through. Only the tenant ids leave this file.
 */

async function tenantsWhere(
  withTenant: WithTenant,
  setting: 'app.lookup_provider_message_id' | 'app.lookup_recipient_hash',
  value: string,
): Promise<string[]> {
  return withTenant({ tenantId: NO_TENANT, userId: SYSTEM_USER_ID }, async (tx) => {
    await tx.execute(sql`select set_config(${setting}, ${value}, true)`);
    const rows = await tx.execute<{ tenant_id: string }>(
      sql`select distinct tenant_id from message order by tenant_id`,
    );
    return rows.rows.map((row) => row.tenant_id);
  });
}

/** The organization that sent the message the provider calls this. At most one. */
export function tenantsByProviderMessageId(
  withTenant: WithTenant,
  providerMessageId: string,
): Promise<string[]> {
  return tenantsWhere(withTenant, 'app.lookup_provider_message_id', providerMessageId);
}

/** The organizations that wrote to a number (by its hash) over WhatsApp. */
export function tenantsByRecipientHash(
  withTenant: WithTenant,
  recipientHash: string,
): Promise<string[]> {
  return tenantsWhere(withTenant, 'app.lookup_recipient_hash', recipientHash);
}
