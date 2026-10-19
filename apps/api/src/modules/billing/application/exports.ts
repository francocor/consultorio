import {
  EXPORT_FORMATS,
  EXPORT_KINDS,
  EXPORT_STATUSES,
  effectivePermissions,
  type CreateExportRequest,
  type DownloadLinkResponse,
  type ExportRequestDto,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';

import { exportRequest, type ExportRequestRow } from '../../../db/schema/billing-payments.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { EXPORT_BUILD_JOB, type ExportStore } from '../../../platform/exports/export-job.js';
import { EXPORT_CONTENT_TYPES } from '../../../platform/exports/types.js';
import { FileRefused, type FileResource } from '../../../platform/files/file-resources.js';
import { AppError } from '../../../platform/http/problem.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import type { PdfBranding } from '../../../platform/pdf/render.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import { readOrganizationName } from '../../tenancy/index.js';

import { CURRENT_TENANT, type BillingActor } from './common.js';
import { ExportFilters, storedScope } from './export-sources.js';
import { billingScopeOf, type ScopeViewer } from './scope.js';

function oneOf<T extends string>(values: readonly T[], value: string): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`unexpected value "${value}" in an export`);
  return found;
}

function toDto(row: ExportRequestRow): ExportRequestDto {
  const filters = ExportFilters.parse(row.filters);
  return {
    id: row.id,
    kind: oneOf(EXPORT_KINDS, row.kind),
    format: oneOf(EXPORT_FORMATS, row.format),
    status: oneOf(EXPORT_STATUSES, row.status),
    from: filters.from,
    to: filters.to,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    rowCount: row.rowCount,
    failureCode: row.failureCode,
  };
}

/**
 * Asks for an export (billing-payments, "Exports"). The request is stored with the scope of the
 * person who asked (decided here, on the server) and queued for the `export.build` job in the same
 * transaction; the event is audited with the filters and the author. The file comes later.
 */
export async function requestExport(
  tx: Tx,
  input: {
    request: CreateExportRequest;
    actor: BillingActor;
    viewer: ScopeViewer;
    tenantId: string;
    jobs: JobClient | undefined;
  },
): Promise<ExportRequestDto> {
  if (!input.jobs) throw new AppError('service_unavailable');
  const { request } = input;
  const scope = await billingScopeOf(tx, input.viewer);
  const filters: ExportFilters = {
    from: request.from,
    to: request.to,
    ...(request.locationId ? { locationId: request.locationId } : {}),
    ...(request.professionalId ? { professionalId: request.professionalId } : {}),
    ...(request.tenantPayerId ? { tenantPayerId: request.tenantPayerId } : {}),
    scope: storedScope(scope),
  };

  const [row] = await tx
    .insert(exportRequest)
    .values({
      tenantId: CURRENT_TENANT,
      kind: request.kind,
      format: request.format,
      filters,
      requestedBy: input.actor.userId,
    })
    .returning();
  if (!row) throw new Error('export request insert returned no row');

  await input.jobs.enqueue(tx, EXPORT_BUILD_JOB, { tenantId: input.tenantId, exportId: row.id });
  await audit(tx, {
    action: 'export.requested',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'export',
    resourceId: row.id,
    metadata: {
      kind: request.kind,
      format: request.format,
      from: request.from,
      to: request.to,
      ...(request.locationId ? { locationId: request.locationId } : {}),
      ...(request.professionalId ? { professionalId: request.professionalId } : {}),
      ...(request.tenantPayerId ? { tenantPayerId: request.tenantPayerId } : {}),
    },
  });
  return toDto(row);
}

/** The exports a person asked for, newest first. Nobody sees another person's. */
export async function listExports(tx: Tx, userId: string): Promise<ExportRequestDto[]> {
  const rows = await tx
    .select()
    .from(exportRequest)
    .where(eq(exportRequest.requestedBy, userId))
    .orderBy(desc(exportRequest.createdAt), desc(exportRequest.id))
    .limit(30);
  return rows.map(toDto);
}

async function ownExport(tx: Tx, id: string, userId: string): Promise<ExportRequestRow> {
  const [row] = await tx
    .select()
    .from(exportRequest)
    .where(and(eq(exportRequest.id, id), eq(exportRequest.requestedBy, userId)));
  // Another person's export answers like one that does not exist.
  if (!row) throw new AppError('not_found');
  return row;
}

export async function getExport(tx: Tx, id: string, userId: string): Promise<ExportRequestDto> {
  return toDto(await ownExport(tx, id, userId));
}

/** A link to the file, for this session only, valid for five minutes and for one use. */
export async function issueDownload(
  tx: Tx,
  input: { id: string; userId: string; sessionId: string; tokens: ActionTokens },
): Promise<DownloadLinkResponse> {
  const row = await ownExport(tx, input.id, input.userId);
  if (row.status !== 'ready' || row.objectKey === null) throw new AppError('conflict');
  const issued = await input.tokens.issue(tx, {
    kind: 'export_download',
    subjectId: row.id,
    sessionId: input.sessionId,
  });
  return { url: `/files/${issued.token}`, expiresAt: issued.expiresAt.toISOString() };
}

/**
 * The store of the export job over `export_request`. Marking an export ready, empty or failed is
 * the only change a request ever gets.
 */
export const exportStore: ExportStore = {
  async load(tx, id) {
    const [row] = await tx.select().from(exportRequest).where(eq(exportRequest.id, id));
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      format: oneOf(EXPORT_FORMATS, row.format),
      filters: row.filters,
      status: row.status,
    };
  },
  async ready(tx, id, file) {
    await tx
      .update(exportRequest)
      .set({
        status: 'ready',
        objectKey: file.objectKey,
        fileName: file.fileName,
        sizeBytes: file.sizeBytes,
        rowCount: file.rowCount,
        completedAt: file.at,
      })
      .where(eq(exportRequest.id, id));
  },
  async empty(tx, id, at) {
    await tx
      .update(exportRequest)
      .set({ status: 'empty', rowCount: 0, completedAt: at })
      .where(eq(exportRequest.id, id));
  },
  async failed(tx, id, code, at) {
    await tx
      .update(exportRequest)
      .set({ status: 'failed', failureCode: code, completedAt: at })
      .where(eq(exportRequest.id, id));
  },
};

/** The header of a PDF: the name of the organization. */
export async function organizationBranding(tx: Tx): Promise<PdfBranding> {
  return { organizationName: await readOrganizationName(tx) };
}

/**
 * The billing module's part of `GET /files/:token`: the links of `export_download`. The link is
 * bound to the session, works once for five minutes, and is authorized AGAIN when used: only the
 * person who asked, and only while they still may read payments. The file is the one the job stored.
 * The request was audited when it was made, so a download writes no second entry.
 */
export function createExportFileResource(tokens: ActionTokens): FileResource {
  return {
    kind: 'export_download',
    audits: [],
    async redeem(tx, input) {
      const redeemed = await tokens.redeem(tx, 'export_download', input.token, {
        sessionId: input.sessionId,
      });
      // Not a live link of this kind: the door asks the other resources before it refuses.
      if (!redeemed) return null;

      const [row] = await tx
        .select()
        .from(exportRequest)
        .where(eq(exportRequest.id, redeemed.subjectId));
      const mayStillRead = effectivePermissions(input.actor.roles, input.actor.grants).includes(
        'payments.read',
      );
      if (!row || row.requestedBy !== input.actor.userId || !mayStillRead) {
        throw new FileRefused('export_not_allowed', 'export', { resourceId: redeemed.subjectId });
      }
      if (row.status !== 'ready' || row.objectKey === null || row.fileName === null) {
        throw new FileRefused('export_not_ready', 'export', { resourceId: row.id });
      }
      return {
        objectKey: row.objectKey,
        contentType: EXPORT_CONTENT_TYPES[oneOf(EXPORT_FORMATS, row.format)],
        // The name was made by the job from the kind and the day: nothing a person typed.
        contentDisposition: `attachment; filename="${row.fileName}"`,
      };
    },
  };
}
