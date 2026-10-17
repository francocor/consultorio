import type {
  AuditEventDto,
  AuditExportQuery,
  AuditListResponse,
  AuditQuery,
} from '@consultorio/contracts';
import { and, desc, asc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';

import { auditEvent } from '../../../db/schema/audit.js';
import { membership } from '../../../db/schema/identity.js';
import { patient } from '../../../db/schema/patients.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

export type AuditFilters = Pick<
  AuditQuery,
  'actorUserId' | 'action' | 'outcome' | 'patientId' | 'resourceType' | 'resourceId' | 'from' | 'to'
>;

export type Order = 'newest_first' | 'oldest_first';

export interface AuditLogService {
  list(
    tx: Tx,
    input: { filters: AuditFilters; order: Order; limit: number; cursor?: string | undefined },
  ): Promise<AuditListResponse>;
  /** The entries of one patient, oldest first. */
  accessReport(
    tx: Tx,
    input: { patientId: string; limit: number; cursor?: string | undefined },
  ): Promise<AuditListResponse>;
  /** Records that an export is about to happen. Throws if it cannot: no entry, no export. */
  recordExport(
    tx: Tx,
    input: {
      actor: AuditActor & { userId: string };
      format: 'csv' | 'json';
      query: AuditExportQuery;
    },
  ): Promise<void>;
  /** Every entry matching the filters, a page at a time, newest first. */
  pages(
    withTenant: WithTenant,
    context: { tenantId: string; userId: string },
    filters: AuditFilters,
  ): AsyncGenerator<AuditEventDto[]>;
}

const PAGE = 500;

/** Microsecond-exact text of the timestamp: a JS Date would drop digits and break the cursor. */
const occurredAtText = sql<string>`to_char(${auditEvent.occurredAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface Cursor {
  at: string;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id])).toString('base64url');
}

function decodeCursor(text: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((part) => typeof part === 'string')
    ) {
      const [at, id] = parsed as [string, string];
      if (!Number.isNaN(Date.parse(at)) && /^[0-9a-f-]{36}$/i.test(id)) return { at, id };
    }
  } catch {
    // Falls through to the error below.
  }
  throw new AppError('validation_failed', [{ path: 'cursor', i18nKey: 'errors.field_invalid' }]);
}

function conditionsOf(filters: AuditFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.actorUserId) conditions.push(eq(auditEvent.actorUserId, filters.actorUserId));
  if (filters.action) conditions.push(eq(auditEvent.action, filters.action));
  if (filters.outcome) conditions.push(eq(auditEvent.outcome, filters.outcome));
  if (filters.patientId) conditions.push(eq(auditEvent.patientId, filters.patientId));
  if (filters.resourceType) conditions.push(eq(auditEvent.resourceType, filters.resourceType));
  if (filters.resourceId) conditions.push(eq(auditEvent.resourceId, filters.resourceId));
  if (filters.from) conditions.push(gte(auditEvent.occurredAt, new Date(filters.from)));
  if (filters.to) conditions.push(lt(auditEvent.occurredAt, new Date(filters.to)));
  return conditions;
}

export function createAuditLogService(): AuditLogService {
  async function page(
    tx: Tx,
    input: { filters: AuditFilters; order: Order; limit: number; cursor?: string | undefined },
  ): Promise<AuditListResponse> {
    const conditions = conditionsOf(input.filters);
    if (input.cursor !== undefined) {
      const after = decodeCursor(input.cursor);
      conditions.push(
        input.order === 'newest_first'
          ? sql`(${auditEvent.occurredAt}, ${auditEvent.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`
          : sql`(${auditEvent.occurredAt}, ${auditEvent.id}) > (${after.at}::timestamptz, ${after.id}::uuid)`,
      );
    }
    const sort = input.order === 'newest_first' ? desc : asc;
    const rows = await tx
      .select({
        id: auditEvent.id,
        at: occurredAtText,
        actorUserId: auditEvent.actorUserId,
        actorName: membership.displayName,
        actingRole: auditEvent.actingRole,
        action: auditEvent.action,
        resourceType: auditEvent.resourceType,
        resourceId: auditEvent.resourceId,
        patientId: auditEvent.patientId,
        outcome: auditEvent.outcome,
        reason: auditEvent.reason,
        ip: sql<string | null>`host(${auditEvent.ip})`,
        requestId: auditEvent.requestId,
        metadata: auditEvent.metadata,
        seq: auditEvent.seq,
      })
      .from(auditEvent)
      .leftJoin(membership, eq(membership.userId, auditEvent.actorUserId))
      .where(and(...conditions))
      .orderBy(sort(auditEvent.occurredAt), sort(auditEvent.id))
      .limit(input.limit + 1);

    const shown = rows.slice(0, input.limit);
    const last = shown.at(-1);
    return {
      events: shown.map((row) => ({
        id: row.id,
        occurredAt: row.at,
        actorUserId: row.actorUserId,
        actorName: row.actorName,
        actingRole: row.actingRole,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        patientId: row.patientId,
        outcome: row.outcome === 'deny' ? 'deny' : 'allow',
        reason: row.reason,
        ip: row.ip,
        requestId: row.requestId,
        metadata: row.metadata,
        sealed: row.seq !== null,
      })),
      nextCursor:
        rows.length > input.limit && last ? encodeCursor({ at: last.at, id: last.id }) : null,
    };
  }

  return {
    list: (tx, input) => page(tx, input),

    async accessReport(tx, input) {
      const [row] = await tx
        .select({ id: patient.id })
        .from(patient)
        .where(eq(patient.id, input.patientId));
      if (!row) throw new AppError('not_found');
      return page(tx, {
        filters: { patientId: input.patientId },
        order: 'oldest_first',
        limit: input.limit,
        cursor: input.cursor,
      });
    },

    async recordExport(tx, input) {
      const filters = Object.keys(input.query).filter((name) => name !== 'format');
      await audit(tx, {
        action: 'audit.exported',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'audit_log',
        ...(input.query.patientId ? { patientId: input.query.patientId } : {}),
        // Which filters were used, never their values: the trail of the export is not a copy of it.
        metadata: { format: input.format, filters },
      });
    },

    async *pages(withTenant, context, filters) {
      let cursor: string | undefined;
      do {
        const current: AuditListResponse = await withTenant(context, (tx) =>
          page(tx, { filters, order: 'newest_first', limit: PAGE, cursor }),
        );
        if (current.events.length > 0) yield current.events;
        cursor = current.nextCursor ?? undefined;
      } while (cursor !== undefined);
    },
  };
}
