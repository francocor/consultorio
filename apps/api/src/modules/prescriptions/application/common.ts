import type { PrescriptionProvider, PrescriptionResult } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';

import { tenant } from '../../../db/schema/tenant.js';
import type { AdapterResolver, TenantRef } from '../../../main/adapter-resolver.js';
import type { AuditActor } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import type { ObjectStorage } from '../../../platform/storage/object-storage.js';

/** The organization of the transaction, as a column value. */
export const CURRENT_TENANT = sql`current_setting('app.tenant_id')::uuid`;

/** The zone the date of a prescription is read in: the country pack of Argentina (the only one today). */
export const DEFAULT_TIME_ZONE = 'America/Argentina/Buenos_Aires';

/** Where the encrypted columns live; the ciphertext is bound to table, column and row. */
export const CONTENT_FIELD = { table: 'prescription', column: 'content_enc' } as const;
export const CANCEL_REASON_FIELD = { table: 'prescription', column: 'cancel_reason_enc' } as const;
export const CREDENTIALS_FIELD = { table: 'erx_connection', column: 'credentials_enc' } as const;

/** The system acts: there is no person, session or address behind an automatic attempt. */
export const SYSTEM_ACTOR: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

/** Where the failures nobody is waiting for are written (the worker's log). No message text. */
export interface AttemptLog {
  error(object: Record<string, unknown>, message: string): void;
}

/** What the services of the module are built with. */
export interface PrescriptionDeps {
  keys: TenantKeys;
  adapters?: AdapterResolver | undefined;
  clock: () => Date;
  /** Queues the submission of a prescription the provider did not confirm. */
  jobs?: JobClient | undefined;
  /**
   * Opens a transaction of its own. The attempt of a request runs its steps in short transactions
   * opened with it, so it holds no connection while the provider is waited for; the attempt of a job
   * commits the mark that says "the provider may be answering this" on one before the call, so it
   * survives a crash of the process that made the call. Without it (a caller that only has a
   * transaction) the mark is written in that transaction.
   */
  withTenant?: WithTenant | undefined;
  /** Where the PDF of a prescription lives. Without a bucket a prescription has no document. */
  storage?: ObjectStorage | undefined;
  /** The zone the date of a prescription is read in. */
  timeZone?: string | undefined;
  /** How long a call to the provider is waited for before its outcome counts as unknown (20 s). */
  providerTimeoutMs?: number | undefined;
  log?: AttemptLog | undefined;
}

/** The answer a call to the provider gets when it fails or takes too long: unreachable, outcome unknown. */
export const UNREACHABLE: PrescriptionResult = {
  status: 'retryable',
  message: 'unreachable',
  outcomeUnknown: true,
};

/** How long the provider is waited for before the outcome of a call counts as unknown. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 20_000;

/**
 * A call to the provider that cannot hang whoever makes it (JD-S5 R1-B-T10): when the provider does
 * not answer in time, or the call fails, the answer is `fallback`, which says "unreachable, outcome
 * unknown" and is handled like a lost answer (the next attempt asks for the key first).
 */
export async function withinTime<T>(
  deps: Pick<PrescriptionDeps, 'providerTimeoutMs'>,
  call: () => Promise<T>,
  fallback: T,
): Promise<T> {
  const limit = deps.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(fallback);
    }, limit);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(call)
        .catch(() => fallback),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface Organization extends TenantRef {
  /** Whether the organization is read-only or cancelled: nothing is submitted for it. */
  active: boolean;
  /** The name that heads the documents. */
  displayName: string;
}

/** The organization of the transaction. */
export async function loadOrganization(tx: Tx): Promise<Organization> {
  const [row] = await tx
    .select({
      id: tenant.id,
      isDemo: tenant.isDemo,
      status: tenant.status,
      slug: tenant.slug,
      theme: tenant.theme,
    })
    .from(tenant)
    .where(eq(tenant.id, CURRENT_TENANT));
  if (!row) throw new Error('the organization of the transaction does not exist');
  const named = row.theme['displayName'];
  return {
    id: row.id,
    isDemo: row.isDemo,
    active: row.status === 'active',
    displayName: typeof named === 'string' && named.trim() !== '' ? named.trim() : row.slug,
  };
}

/** The provider that serves this organization, or undefined (none configured, or none for it). */
export function providerFor(
  adapters: AdapterResolver | undefined,
  organization: TenantRef,
): PrescriptionProvider | undefined {
  return adapters?.forTenant(
    { id: organization.id, isDemo: organization.isDemo },
    'prescriptionProvider',
  );
}

/**
 * A provider that only pretends to be the authorized platform: the in-memory fake and the local
 * simulator. Both carry `simulated: true`, and that is how the module knows to say "simulated" on
 * every screen and to stamp the document.
 */
export function isSimulated(provider: PrescriptionProvider | undefined): boolean {
  return provider !== undefined && (provider as { simulated?: unknown }).simulated === true;
}

/** Postgres error codes the module tells apart. */
export const UNIQUE_VIOLATION = '23505';

export function sqlState(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code = cause?.code ?? (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export function constraintOf(error: unknown): string | undefined {
  const cause = (error as { cause?: { constraint?: unknown } } | null)?.cause;
  const constraint = cause?.constraint ?? (error as { constraint?: unknown } | null)?.constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}
