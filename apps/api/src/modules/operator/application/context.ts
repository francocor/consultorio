import type { Db } from '../../../platform/db/pool.js';
import { createWithTenant, type Tx } from '../../../platform/db/tenant-context.js';

/**
 * The "tenant" of a transaction that is about no organization in particular (signing in, listing
 * organizations). Row level security reads `app.tenant_id` without a default, so an operator
 * transaction always sets one; the nil UUID matches no organization.
 */
export const PLATFORM_SCOPE = '00000000-0000-0000-0000-000000000000';

export interface OperatorScope {
  /** The organization the transaction is about; omitted for platform-wide work. */
  tenantId?: string;
  operatorId?: string | null;
}

/** Runs a callback in one transaction of the operator connection, with the context set. */
export type OperatorRun = <T>(scope: OperatorScope, fn: (tx: Tx) => Promise<T>) => Promise<T>;

export function createOperatorRun(db: Db): OperatorRun {
  const run = createWithTenant(db);
  return (scope, fn) =>
    run(
      { tenantId: scope.tenantId ?? PLATFORM_SCOPE, userId: scope.operatorId ?? PLATFORM_SCOPE },
      fn,
    );
}

/** Who is acting, as the console knows them. */
export interface OperatorIdentity {
  id: string;
  email: string;
  displayName: string;
}
