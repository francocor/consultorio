import { AuditMetadata } from '@consultorio/contracts';
import { and, eq, sql } from 'drizzle-orm';

import { tenantArchive, type TenantArchiveRow } from '../../../db/schema/archive-key.js';
import { exportPackage } from '../../../db/schema/export-package.js';
import { tenant } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * The rows and the trail of the archive of one organization, always inside a transaction of that
 * organization (row level security). Kept together because the three archive jobs read and write the
 * same few things: whether the organization is cancelled and since when, the state of its archive,
 * and the platform-trail entry that says what was done.
 */

export interface CancellationFacts {
  /** `cancelled` is the only state that is archived. */
  status: string;
  /** When the end of the organization was announced (the request of its administrative export). */
  cancelledAt: Date | null;
}

export async function cancellationFacts(tx: Tx): Promise<CancellationFacts | null> {
  const [state] = await tx.select({ status: tenant.status }).from(tenant);
  if (!state) return null;
  const [request] = await tx
    .select({ at: exportPackage.createdAt })
    .from(exportPackage)
    .where(eq(exportPackage.kind, 'administrative'));
  return { status: state.status, cancelledAt: request?.at ?? null };
}

export async function findArchive(tx: Tx): Promise<TenantArchiveRow | null> {
  const [row] = await tx.select().from(tenantArchive);
  return row ?? null;
}

/**
 * Starts the archive of the organization, or finds the one that started. `archive_id` and the
 * retention are fixed by the first attempt: a retry (a new attempt folder) keeps the same archive.
 */
export async function beginArchive(
  tx: Tx,
  input: { keyVersion: number; retainUntil: Date },
): Promise<TenantArchiveRow> {
  await tx.execute(sql`
    insert into tenant_archive (tenant_id, archive_id, key_version, retain_until)
    values (current_setting('app.tenant_id')::uuid, app.uuid_v7(), ${input.keyVersion}, ${input.retainUntil.toISOString()}::timestamptz)
    on conflict (tenant_id) do nothing`);
  const row = await findArchive(tx);
  if (!row) throw new Error('the archive was not started');
  // An attempt that restarts is "alive": the sweeper leaves a pending archive alone for an hour.
  await tx
    .update(tenantArchive)
    .set({ updatedAt: new Date() })
    .where(and(eq(tenantArchive.id, row.id), eq(tenantArchive.status, 'pending')));
  return row;
}

export async function markArchiveWritten(
  tx: Tx,
  id: string,
  input: {
    manifestKey: string;
    manifestSha256: string;
    objectsCount: number;
    bytesTotal: number;
    at: Date;
  },
): Promise<boolean> {
  const updated = await tx
    .update(tenantArchive)
    .set({
      status: 'written',
      manifestKey: input.manifestKey,
      manifestSha256: input.manifestSha256,
      objectsCount: input.objectsCount,
      bytesTotal: input.bytesTotal,
      archivedAt: input.at,
    })
    .where(and(eq(tenantArchive.id, id), eq(tenantArchive.status, 'pending')))
    .returning({ id: tenantArchive.id });
  return updated.length > 0;
}

export async function markArchiveFailed(tx: Tx, id: string, code: string): Promise<void> {
  await tx
    .update(tenantArchive)
    .set({ status: 'failed', failureCode: code })
    .where(and(eq(tenantArchive.id, id), eq(tenantArchive.status, 'pending')));
}

/** True when the object (a key of the archive store) is under a folder a legal erasure removed. */
export function isUnderErased(
  archive: Pick<TenantArchiveRow, 'erasedPrefixes'>,
  name: string,
): boolean {
  return archive.erasedPrefixes.some((prefix) => name.startsWith(prefix));
}

/** True when any object of the part was erased: a part is whole or it is not there. */
export function partIsErased(
  archive: Pick<TenantArchiveRow, 'erasedPrefixes'>,
  part: { objects: readonly { name: string }[] },
): boolean {
  return part.objects.some((object) => isUnderErased(archive, object.name));
}

export type VerifyStatus = 'ok' | 'corrupted' | 'missing' | 'overwritten';

export async function recordVerification(
  tx: Tx,
  id: string,
  input: { status: VerifyStatus; problems: number; at: Date },
): Promise<void> {
  await tx
    .update(tenantArchive)
    .set({ verifiedAt: input.at, verifyStatus: input.status, verifyProblems: input.problems })
    .where(eq(tenantArchive.id, id));
}

/** The two actions the worker writes about an archive (`archive.write`, `archive.verify`). */
export type ArchiveAuditAction = 'archive.written' | 'archive.verified';

/**
 * One entry of the platform trail about the organization of the transaction, for the jobs of the
 * worker. The runtime role cannot write that table, so it goes through the definer function of
 * migration 0653 (restricted to these two actions in 0688). The entries of a release have functions of
 * their own that only the releaser (`writeReleaseAudit`) and the API (`writeDownloadAudit`) can call.
 * The metadata is flat scalars, checked like any audit metadata (no content, no secret).
 */
export async function writeArchiveAudit(
  tx: Tx,
  entry: {
    action: ArchiveAuditAction;
    resourceType: string;
    resourceId: string;
    reason?: string;
    metadata?: AuditMetadata;
  },
): Promise<void> {
  const metadata = AuditMetadata.parse(entry.metadata ?? {});
  await tx.execute(sql`select app.write_archive_audit(
    ${entry.action}, ${entry.resourceType}, ${entry.resourceId}::uuid,
    ${entry.reason ?? null}, ${JSON.stringify(metadata)}::jsonb)`);
}

/**
 * An entry of the release: the archive was opened (`archive.accessed`) or a request was delivered,
 * failed or expired (`archive.released`). Only the releaser's role may call the function, and only
 * about an approved request of the organization of the transaction (migration 0688).
 */
export async function writeReleaseAudit(
  tx: Tx,
  entry: {
    action: 'archive.accessed' | 'archive.released';
    requestId: string;
    reason?: string;
    metadata?: AuditMetadata;
  },
): Promise<void> {
  const metadata = AuditMetadata.parse(entry.metadata ?? {});
  await tx.execute(sql`select app.write_release_audit(
    ${entry.action}, ${entry.requestId}::uuid, ${entry.reason ?? null},
    ${JSON.stringify(metadata)}::jsonb)`);
}

/** The entry that says a released package was handed over (written by the API, which serves the link). */
export async function writeDownloadAudit(tx: Tx, requestId: string): Promise<void> {
  await tx.execute(sql`select app.write_download_audit(${requestId}::uuid)`);
}
