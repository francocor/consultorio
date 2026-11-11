import {
  type ArchiveOverviewResponse,
  type ArchiveReleaseListResponse,
  type ArchiveReleaseRequestDto,
  type RecordArchiveReleaseRequest,
  type VerifyArchiveReleaseIdentityRequest,
} from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';

import {
  archiveReleaseRequest,
  type ArchiveReleaseRequestRow,
} from '../../../db/schema/archive-release.js';
import {
  writePlatformAudit,
  type PlatformAuditActor,
} from '../../../platform/audit/platform-audit.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { OperatorIdentity, OperatorRun } from '../../operator/index.js';

/**
 * The operator's side of the break-glass release (tenancy, "Tenant cancellation export": records in the
 * custody of the platform are released only to the patient themselves, identity verified, or to a
 * verified professional, with an audit entry, and the operator cannot read the content). The operator
 * RECORDS a request, VERIFIES the identity of the requester out of band, and a DIFFERENT operator
 * (neither the one who recorded it nor the one who verified) APPROVES; the releaser does the rest.
 * Every step is an entry of the platform trail with the operator's own id, and the database repeats
 * the rules: the step names the operator of the session, and a request that waited seven days is
 * closed by the releaser instead of being approved late.
 *
 * Nothing here reads the archive: the operator's database role has no privilege on any table that
 * holds a key, a name of an object or a record, and the one question it may ask about an archive is
 * whether it is written (`app.archive_is_written`).
 */

type Meta = Omit<PlatformAuditActor, 'operatorId'>;

/** The window to carry out an approved request before it expires. */
export const ARCHIVE_RELEASE_WINDOW_DAYS = 7;
export { ARCHIVE_RELEASE_OPEN_DAYS } from '@consultorio/contracts';
const DAY_MS = 86_400_000;

export interface ReleaseRequests {
  list(operator: OperatorIdentity): Promise<ArchiveReleaseListResponse>;
  record(
    input: RecordArchiveReleaseRequest,
    operator: OperatorIdentity,
    meta: Meta,
  ): Promise<ArchiveReleaseRequestDto>;
  verifyIdentity(
    id: string,
    checklist: VerifyArchiveReleaseIdentityRequest,
    operator: OperatorIdentity,
    meta: Meta,
  ): Promise<ArchiveReleaseRequestDto>;
  approve(id: string, operator: OperatorIdentity, meta: Meta): Promise<ArchiveReleaseRequestDto>;
  reject(
    id: string,
    reason: string,
    operator: OperatorIdentity,
    meta: Meta,
  ): Promise<ArchiveReleaseRequestDto>;
  /** The state of the archives: counts and dates, never a name of an object or a record. */
  archives(): Promise<ArchiveOverviewResponse>;
}

const OPEN_STATUSES: readonly string[] = ['requested', 'identity_verified', 'approved'];

function scopeOf(row: ArchiveReleaseRequestRow): string {
  return row.requesterKind === 'patient'
    ? `${(row.scopeDocumentType ?? '').toUpperCase()} ${row.scopeDocument ?? ''}`.trim()
    : `${row.scopeMatriculaJurisdiction ?? ''} ${row.scopeMatricula ?? ''}`.trim();
}

/**
 * The database refuses a step on a request that is not at it any more (a trigger, 42501): one that
 * waited more than `ARCHIVE_RELEASE_OPEN_DAYS`, or that another session moved on: to the operator that
 * is a request that is no longer at a step to take. Each step also updates `WHERE status = <expected>`,
 * so a request that moved between the lock and the write answers the same way (JD-S6 R3-2).
 */
function staleStep(error: unknown): never {
  const e = error as { cause?: { code?: string; message?: string }; code?: string } | null;
  const code = e?.cause?.code ?? e?.code;
  const message = e?.cause?.message ?? (error as { message?: string } | null)?.message ?? '';
  // Only the refusal of a STEP is a request that is not at that step: any other 42501 (a privilege, a
  // row level security policy, the guard of who took a step) is a defect and must not be hidden.
  if (code === '42501' && message.includes('cannot go from')) {
    throw new AppError('archive_release_wrong_step');
  }
  throw error;
}

/** A timestamp as ISO text. A raw query returns the driver's text for it, the query builder a Date. */
const iso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();

function statusOf(row: ArchiveReleaseRequestRow): ArchiveReleaseRequestDto['status'] {
  const known = [
    'requested',
    'identity_verified',
    'approved',
    'released',
    'rejected',
    'expired',
    'failed',
  ] as const;
  const found = known.find((status) => status === row.status);
  if (!found) throw new Error(`unexpected release status "${row.status}"`);
  return found;
}

export function toRequestDto(
  row: ArchiveReleaseRequestRow,
  operator: OperatorIdentity,
): ArchiveReleaseRequestDto {
  const status = statusOf(row);
  return {
    id: row.id,
    organization: row.targetTenantId,
    status,
    requesterKind: row.requesterKind === 'professional' ? 'professional' : 'patient',
    requesterName: row.requesterName,
    requesterEmail: row.requesterEmail,
    scope: scopeOf(row),
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    identityVerifiedAt: iso(row.identityVerifiedAt),
    approvedAt: iso(row.approvedAt),
    expiresAt: iso(row.expiresAt),
    releasedAt: iso(row.releasedAt),
    linkExpiresAt: iso(row.linkExpiresAt),
    downloadedAt: iso(row.downloadedAt),
    rejectedReason: row.rejectedReason,
    failureCode: row.failureCode,
    canVerifyIdentity: status === 'requested',
    // Three pairs of eyes: neither the person who recorded the request nor the one who verified the
    // identity approves it (JD-S6 R1-S6-4).
    canApprove:
      status === 'identity_verified' &&
      row.identityVerifiedBy !== operator.id &&
      row.recordedBy !== operator.id,
    canReject: OPEN_STATUSES.includes(status),
  };
}

export function createReleaseRequests(deps: {
  run: OperatorRun;
  clock?: () => Date;
}): ReleaseRequests {
  const now = deps.clock ?? (() => new Date());

  async function load(tx: Tx, id: string): Promise<ArchiveReleaseRequestRow> {
    const rows = await tx.execute<{ id: string }>(
      sql`select id from archive_release_request where id = ${id}::uuid for update`,
    );
    if (rows.rows.length === 0) throw new AppError('not_found');
    const [row] = await tx
      .select()
      .from(archiveReleaseRequest)
      .where(eq(archiveReleaseRequest.id, id));
    if (!row) throw new AppError('not_found');
    return row;
  }

  async function trail(
    tx: Tx,
    row: ArchiveReleaseRequestRow,
    operator: OperatorIdentity,
    meta: Meta,
    phase: string,
  ): Promise<void> {
    await writePlatformAudit(tx, {
      action: 'archive.released',
      outcome: 'allow',
      actor: { ...meta, operatorId: operator.id },
      targetTenantId: row.targetTenantId,
      resourceType: 'archive_release_request',
      resourceId: row.id,
      metadata: { phase, requesterKind: row.requesterKind },
    });
  }

  return {
    async list(operator) {
      return deps.run({ operatorId: operator.id }, async (tx) => {
        const rows = await tx
          .select()
          .from(archiveReleaseRequest)
          .orderBy(desc(archiveReleaseRequest.createdAt), desc(archiveReleaseRequest.id))
          .limit(200);
        return { requests: rows.map((row) => toRequestDto(row, operator)) };
      });
    },

    async record(input, operator, meta) {
      return deps.run({ operatorId: operator.id }, async (tx) => {
        const written = await tx.execute<{ written: boolean }>(
          sql`select app.archive_is_written(${input.organization}::uuid) as written`,
        );
        if (written.rows[0]?.written !== true) throw new AppError('archive_release_no_archive');

        // Plain SQL naming the columns the operator may write: the query builder names every column
        // of the table, and the operator's right to insert is limited to these.
        const inserted = await tx.execute<{ id: string }>(sql`
          insert into archive_release_request
            (target_tenant_id, requester_kind, requester_name, requester_email,
             scope_document_type, scope_document, scope_matricula_jurisdiction, scope_matricula,
             reason, recorded_by)
          values
            (${input.organization}::uuid, ${input.requesterKind}, ${input.requesterName},
             ${input.requesterEmail}, ${input.documentType ?? null}, ${input.document ?? null},
             ${input.matriculaJurisdiction ?? null}, ${input.matricula ?? null}, ${input.reason},
             ${operator.id}::uuid)
          returning id`);
        const id = inserted.rows[0]?.id;
        if (!id) throw new Error('the release request was not stored');
        const [row] = await tx
          .select()
          .from(archiveReleaseRequest)
          .where(eq(archiveReleaseRequest.id, id));
        if (!row) throw new Error('the release request was not stored');
        await trail(tx, row, operator, meta, 'recorded');
        return toRequestDto(row, operator);
      });
    },

    async verifyIdentity(id, checklist, operator, meta) {
      return deps.run({ operatorId: operator.id }, async (tx) => {
        const current = await load(tx, id);
        if (current.status !== 'requested') throw new AppError('archive_release_wrong_step');
        const [row] = await tx
          .update(archiveReleaseRequest)
          .set({
            status: 'identity_verified',
            identityChecklist: checklist,
            identityVerifiedBy: operator.id,
            identityVerifiedAt: now(),
          })
          .where(
            and(eq(archiveReleaseRequest.id, id), eq(archiveReleaseRequest.status, 'requested')),
          )
          .returning()
          .catch(staleStep);
        if (!row) throw new AppError('archive_release_wrong_step');
        await trail(tx, row, operator, meta, 'identity_verified');
        return toRequestDto(row, operator);
      });
    },

    async approve(id, operator, meta) {
      return deps.run({ operatorId: operator.id }, async (tx) => {
        const current = await load(tx, id);
        if (current.status !== 'identity_verified')
          throw new AppError('archive_release_wrong_step');
        // Three pairs of eyes: the database refuses it too (two checks), this says why.
        if (current.identityVerifiedBy === operator.id || current.recordedBy === operator.id) {
          throw new AppError('archive_release_same_operator');
        }
        const at = now();
        const [row] = await tx
          .update(archiveReleaseRequest)
          .set({
            status: 'approved',
            approvedBy: operator.id,
            approvedAt: at,
            expiresAt: new Date(at.getTime() + ARCHIVE_RELEASE_WINDOW_DAYS * DAY_MS),
          })
          .where(
            and(
              eq(archiveReleaseRequest.id, id),
              eq(archiveReleaseRequest.status, 'identity_verified'),
            ),
          )
          .returning()
          .catch(staleStep);
        if (!row) throw new AppError('archive_release_wrong_step');
        await trail(tx, row, operator, meta, 'approved');
        return toRequestDto(row, operator);
      });
    },

    async reject(id, reason, operator, meta) {
      return deps.run({ operatorId: operator.id }, async (tx) => {
        const current = await load(tx, id);
        if (!OPEN_STATUSES.includes(current.status))
          throw new AppError('archive_release_wrong_step');
        const [row] = await tx
          .update(archiveReleaseRequest)
          .set({ status: 'rejected', rejectedBy: operator.id, rejectedReason: reason })
          .where(
            and(eq(archiveReleaseRequest.id, id), eq(archiveReleaseRequest.status, current.status)),
          )
          .returning()
          .catch(staleStep);
        if (!row) throw new AppError('archive_release_wrong_step');
        await trail(tx, row, operator, meta, 'rejected');
        return toRequestDto(row, operator);
      });
    },

    async archives() {
      return deps.run({}, async (tx) => {
        const result = await tx.execute<{
          tenant_id: string;
          status: string;
          archived_at: Date | string | null;
          objects_count: number | null;
          bytes_total: string | number | null;
          retain_until: Date | string | null;
          verified_at: Date | string | null;
          verify_status: string | null;
          verify_problems: number | null;
        }>(sql`select * from app.archive_overview(100)`);
        return {
          archives: result.rows.map((row) => ({
            organization: row.tenant_id,
            status:
              row.status === 'written'
                ? ('written' as const)
                : row.status === 'failed'
                  ? ('failed' as const)
                  : ('pending' as const),
            archivedAt: iso(row.archived_at),
            objects: row.objects_count,
            bytes: row.bytes_total === null ? null : Number(row.bytes_total),
            retainUntil: iso(row.retain_until),
            verifiedAt: iso(row.verified_at),
            verifyStatus:
              row.verify_status === 'ok' ||
              row.verify_status === 'corrupted' ||
              row.verify_status === 'missing' ||
              row.verify_status === 'overwritten'
                ? row.verify_status
                : null,
            verifyProblems: row.verify_problems,
          })),
        };
      });
    },
  };
}
