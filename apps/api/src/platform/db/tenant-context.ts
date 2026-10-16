import { sql } from 'drizzle-orm';
import type { ClientBase } from 'pg';

import type { Db } from './pool.js';

/** Transaction handle passed to the callback of `withTenant`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface RequestContext {
  tenantId: string;
  userId: string;
  /** Set only when the acting user holds an active professional profile with a valid matricula. */
  actingProfessionalId?: string | null;
}

export type WithTenant = <T>(ctx: RequestContext, fn: (tx: Tx) => Promise<T>) => Promise<T>;

/**
 * Builds the one function every request and job runs its queries through.
 *
 * It opens a transaction and sets the tenant context with `set_config(..., true)`, which is local
 * to the transaction and therefore safe behind connection poolers. Row level security policies
 * read these settings with `current_setting('app.tenant_id')` (no `missing_ok`), so a query that
 * runs outside `withTenant` raises instead of returning another tenant's rows: it fails closed.
 */
export function createWithTenant(db: Db): WithTenant {
  return (ctx, fn) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select
        set_config('app.tenant_id', ${ctx.tenantId}, true),
        set_config('app.user_id', ${ctx.userId}, true),
        set_config('app.professional_id', ${ctx.actingProfessionalId ?? ''}, true)`);
      return fn(tx);
    });
}

/** Nil UUID used as `app.user_id` when the system itself acts (jobs, sealing). */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The node-postgres client a `withTenant` transaction runs on. Needed to hand the SAME connection
 * to another library, such as pg-boss, so its writes join the caller's transaction. Drizzle does
 * not expose the client publicly, so this reads it from the session and fails loudly (and is
 * covered by an integration test) if a Drizzle upgrade ever moves it.
 */
export function rawClientOf(tx: Tx): ClientBase {
  const client = (tx as unknown as { session?: { client?: unknown } }).session?.client;
  if (
    typeof client !== 'object' ||
    client === null ||
    typeof (client as { query?: unknown }).query !== 'function'
  ) {
    throw new Error('Cannot reach the database client of this transaction');
  }
  return client as ClientBase;
}
