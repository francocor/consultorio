import type { ExportPackageDto } from '@consultorio/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';

import { exportPackage, type ExportPackageRow } from '../../../db/schema/export-package.js';
import { membership, userAccount } from '../../../db/schema/identity.js';
import { professional } from '../../../db/schema/staff.js';
import { tenant } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * The rows of `export_package`: the request that the cancellation writes, and the outcome the job
 * records. A package is asked for once (the unique indexes make a second request find the first) and
 * moves one way: `queued`, then `ready` or `failed`.
 */

/**
 * Asks for the administrative package of the organization of the transaction. Written by the
 * subscriber of `TenantCancelled`, whose transaction can be the operator's: that role may insert
 * exactly this row (migration 0650), which is why it is plain SQL naming three columns. Returns the
 * id when the request is new and null when the package was already asked for.
 */
export async function requestAdministrativePackage(tx: Tx): Promise<string | null> {
  const result = await tx.execute<{ id: string }>(sql`
    insert into export_package (tenant_id, kind, status)
    values (current_setting('app.tenant_id')::uuid, 'administrative', 'queued')
    on conflict do nothing
    returning id`);
  return result.rows[0]?.id ?? null;
}

/**
 * Asks for one clinical package for each ACTIVE professional that has none. A professional who left
 * before the cancellation has no package: their patients' records go to the custody of the archive
 * (tenancy, "No professional remains"). Returns how many requests are new.
 */
export async function requestClinicalPackages(tx: Tx): Promise<number> {
  const result = await tx.execute(sql`
    insert into export_package (tenant_id, kind, professional_id, status)
    select p.tenant_id, 'clinical', p.id, 'queued'
      from professional p
      join membership m on m.tenant_id = p.tenant_id and m.id = p.membership_id
     where p.status = 'active' and m.status = 'active'
    on conflict do nothing`);
  return result.rowCount ?? 0;
}

/** The packages still to be made, the administrative one first. */
export function queuedPackages(tx: Tx): Promise<ExportPackageRow[]> {
  return tx
    .select()
    .from(exportPackage)
    .where(eq(exportPackage.status, 'queued'))
    .orderBy(asc(exportPackage.kind), asc(exportPackage.createdAt), asc(exportPackage.id));
}

export interface ReadyPackage {
  objectKey: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  entryCount: number;
  at: Date;
}

/** Records the finished file. Only a queued package becomes ready: a repeated call changes nothing. */
export async function markPackageReady(tx: Tx, id: string, file: ReadyPackage): Promise<boolean> {
  const updated = await tx
    .update(exportPackage)
    .set({
      status: 'ready',
      objectKey: file.objectKey,
      fileName: file.fileName,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      entryCount: file.entryCount,
      builtAt: file.at,
    })
    .where(and(eq(exportPackage.id, id), eq(exportPackage.status, 'queued')))
    .returning({ id: exportPackage.id });
  return updated.length > 0;
}

/** Records why a package cannot be made. A code, never a message. */
export async function markPackageFailed(tx: Tx, id: string, code: string): Promise<void> {
  await tx
    .update(exportPackage)
    .set({ status: 'failed', failureCode: code })
    .where(and(eq(exportPackage.id, id), eq(exportPackage.status, 'queued')));
}

/** The administrative package of the organization of the transaction, if it was asked for. */
export async function findAdministrativePackage(tx: Tx): Promise<ExportPackageRow | null> {
  const [row] = await tx
    .select()
    .from(exportPackage)
    .where(eq(exportPackage.kind, 'administrative'));
  return row ?? null;
}

/** The clinical package made for one professional, if there is one. */
export async function findClinicalPackage(
  tx: Tx,
  professionalId: string,
): Promise<ExportPackageRow | null> {
  const [row] = await tx
    .select()
    .from(exportPackage)
    .where(
      and(eq(exportPackage.kind, 'clinical'), eq(exportPackage.professionalId, professionalId)),
    );
  return row ?? null;
}

export async function findPackage(tx: Tx, id: string): Promise<ExportPackageRow | null> {
  const [row] = await tx.select().from(exportPackage).where(eq(exportPackage.id, id));
  return row ?? null;
}

/** The code a package shows once its file was taken out of the bucket (see `export-cleanup.ts`). */
export const REMOVED_AFTER_ARCHIVE = 'removed_after_archive';

export function toPackageDto(row: ExportPackageRow): ExportPackageDto {
  const kind = row.kind === 'clinical' ? 'clinical' : 'administrative';
  // A package whose file was removed has nothing to download: it is told apart from one that could
  // not be made by its code, and offers no download.
  if (row.objectRemovedAt !== null) {
    return {
      id: row.id,
      kind,
      status: 'failed',
      fileName: null,
      sizeBytes: null,
      builtAt: row.builtAt?.toISOString() ?? null,
      failureCode: REMOVED_AFTER_ARCHIVE,
    };
  }
  const status =
    row.status === 'ready' ? 'ready' : row.status === 'failed' ? 'failed' : ('queued' as const);
  return {
    id: row.id,
    kind,
    status,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    builtAt: row.builtAt?.toISOString() ?? null,
    failureCode: row.failureCode,
  };
}

export interface PackageRecipient {
  email: string;
  displayName: string | null;
}

/** The person a clinical package is made for: the member behind the professional profile. */
export async function clinicalRecipient(
  tx: Tx,
  professionalId: string,
): Promise<(PackageRecipient & { userId: string }) | null> {
  const [row] = await tx
    .select({
      userId: membership.userId,
      email: userAccount.email,
      displayName: membership.displayName,
    })
    .from(professional)
    .innerJoin(membership, eq(membership.id, professional.membershipId))
    .innerJoin(userAccount, eq(userAccount.id, membership.userId))
    .where(eq(professional.id, professionalId));
  return row ?? null;
}

/** The people who receive the administrative package: the owners of the organization. */
export function ownerRecipients(tx: Tx): Promise<PackageRecipient[]> {
  return tx
    .select({ email: userAccount.email, displayName: membership.displayName })
    .from(membership)
    .innerJoin(userAccount, eq(userAccount.id, membership.userId))
    .where(and(eq(membership.status, 'active'), sql`'owner' = any(${membership.roles})`))
    .orderBy(asc(membership.createdAt));
}

/** The slug that builds the address of the organization's links. */
export async function tenantSlug(tx: Tx): Promise<string | null> {
  const [row] = await tx.select({ slug: tenant.slug }).from(tenant);
  return row?.slug ?? null;
}
