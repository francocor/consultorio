import type {
  WorklistAction,
  WorklistItemDto,
  WorklistKind,
  WorklistQuery,
  WorklistResponse,
  WorklistSubjectType,
} from '@consultorio/contracts';
import { and, asc, count, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import { patient } from '../../../db/schema/patients.js';
import { appointment } from '../../../db/schema/scheduling.js';
import { worklistItem, type WorklistItemRow } from '../../../db/schema/worklist.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../platform/db/uuid.js';
import { AppError } from '../../../platform/http/problem.js';
import { visibleLocationIds, type LocationViewer } from '../../access/index.js';

export interface OpenItemInput {
  kind: WorklistKind;
  subjectType: WorklistSubjectType;
  subjectId: string;
  /** Omit for an item that belongs to the whole organization. */
  locationId?: string | undefined;
  /** Administrative detail, stored encrypted (never clinical content). */
  detail?: Record<string, unknown> | undefined;
}

export interface CloseItemInput {
  id: string;
  viewer: LocationViewer;
  actor: AuditActor & { userId: string };
  status: 'resolved' | 'dismissed';
  /** How it ended, as a code. */
  resolution: string;
  /**
   * The decision actions close an identity review and a pending approval (they end with a decision
   * on the appointment); a plain resolve or dismiss must not.
   */
  viaIdentityAction?: boolean;
}

/**
 * The reception worklist. Capabilities add their items with `openItem`; people see them with
 * `list` and close them with `close`. Nothing here deletes an item.
 */
export interface WorklistService {
  /** Opens an item. Idempotent: an open item of the same kind and subject is returned as it is. */
  openItem(tx: Tx, input: OpenItemInput): Promise<{ id: string; created: boolean }>;
  /** The items the viewer may see: their locations plus the ones of the whole organization. */
  list(tx: Tx, viewer: LocationViewer, query: WorklistQuery): Promise<WorklistResponse>;
  /** One item the viewer may see, or not found. */
  get(tx: Tx, viewer: LocationViewer, id: string): Promise<WorklistItemDto>;
  close(tx: Tx, input: CloseItemInput): Promise<WorklistItemDto>;
  /**
   * Closes the open item of a kind about a subject, whoever can see it (an action on the subject
   * itself settled it: an identity was confirmed, an appointment was cancelled). No-op when none.
   */
  closeBySubject(
    tx: Tx,
    input: {
      kind: WorklistKind;
      subjectType: WorklistSubjectType;
      subjectId: string;
      status: 'resolved' | 'dismissed';
      resolution: string;
      actor: AuditActor & { userId: string };
    },
  ): Promise<void>;
}

const FIELD = { table: 'worklist_item', column: 'detail_enc' } as const;

function actionsOf(kind: WorklistKind, subjectType: WorklistSubjectType): WorklistAction[] {
  const open: WorklistAction[] =
    subjectType === 'appointment'
      ? ['open_appointment']
      : subjectType === 'invoice'
        ? ['open_invoice']
        : [];
  switch (kind) {
    case 'pending_approval':
      // Approving (or cancelling) the appointment closes it; a plain close would skip the decision.
      return [...open, 'approve'];
    case 'identity_review':
      // Only the identity actions close it (the appointment's own professional cannot confirm).
      return [...open, 'confirm_identity', 'detach_patient'];
    default:
      return [...open, 'resolve', 'dismiss'];
  }
}

export function createWorklistService(deps: { keys: TenantKeys }): WorklistService {
  async function visibility(tx: Tx, viewer: LocationViewer): Promise<SQL | undefined> {
    const visible = await visibleLocationIds(tx, viewer);
    if (visible === 'all') return undefined;
    return visible.length === 0
      ? isNull(worklistItem.locationId)
      : or(isNull(worklistItem.locationId), inArray(worklistItem.locationId, visible));
  }

  async function present(tx: Tx, rows: readonly WorklistItemRow[]): Promise<WorklistItemDto[]> {
    const appointmentIds = rows
      .filter((row) => row.subjectType === 'appointment')
      .map((row) => row.subjectId);
    const appointments =
      appointmentIds.length === 0
        ? []
        : await tx
            .select({
              id: appointment.id,
              startsAt: appointment.startsAt,
              endsAt: appointment.endsAt,
              status: appointment.status,
              professionalId: appointment.professionalId,
              patientId: appointment.patientId,
              locationId: appointment.locationId,
              identityConfirmed: appointment.identityConfirmed,
              version: appointment.version,
              familyName: patient.familyName,
              givenNames: patient.givenNames,
            })
            .from(appointment)
            .innerJoin(
              patient,
              and(
                eq(patient.tenantId, appointment.tenantId),
                eq(patient.id, appointment.patientId),
              ),
            )
            .where(inArray(appointment.id, appointmentIds));
    const byId = new Map(appointments.map((row) => [row.id, row]));

    const items: WorklistItemDto[] = [];
    for (const row of rows) {
      const found = row.subjectType === 'appointment' ? byId.get(row.subjectId) : undefined;
      let detail: Record<string, unknown> | null = null;
      if (row.detailEnc) {
        const plain = await deps.keys.decryptField(tx, { ...FIELD, rowId: row.id }, row.detailEnc);
        detail = JSON.parse(plain.toString('utf8')) as Record<string, unknown>;
      }
      const kind = row.kind as WorklistKind;
      const subjectType = row.subjectType as WorklistSubjectType;
      items.push({
        id: row.id,
        kind,
        subjectType,
        subjectId: row.subjectId,
        locationId: row.locationId,
        status: row.status as WorklistItemDto['status'],
        createdAt: row.createdAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        resolvedBy: row.resolvedBy,
        resolution: row.resolution,
        detail,
        appointment: found
          ? {
              id: found.id,
              startsAt: found.startsAt.toISOString(),
              endsAt: found.endsAt.toISOString(),
              status: found.status as NonNullable<WorklistItemDto['appointment']>['status'],
              professionalId: found.professionalId,
              patientId: found.patientId,
              patientName: `${found.familyName}, ${found.givenNames}`,
              locationId: found.locationId,
              identityConfirmed: found.identityConfirmed,
              version: found.version,
            }
          : null,
        actions: row.status === 'open' ? actionsOf(kind, subjectType) : [],
      });
    }
    return items;
  }

  return {
    async openItem(tx, input) {
      const id = uuidv7();
      const detailEnc = input.detail
        ? await deps.keys.encryptField(tx, { ...FIELD, rowId: id }, JSON.stringify(input.detail))
        : null;
      const inserted = await tx
        .insert(worklistItem)
        .values({
          id,
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          kind: input.kind,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          locationId: input.locationId ?? null,
          detailEnc,
        })
        .onConflictDoNothing()
        .returning({ id: worklistItem.id });
      if (inserted[0]) return { id: inserted[0].id, created: true };

      const [existing] = await tx
        .select({ id: worklistItem.id })
        .from(worklistItem)
        .where(
          and(
            eq(worklistItem.kind, input.kind),
            eq(worklistItem.subjectType, input.subjectType),
            eq(worklistItem.subjectId, input.subjectId),
            eq(worklistItem.status, 'open'),
          ),
        );
      if (!existing) throw new Error('worklist item neither inserted nor found');
      return { id: existing.id, created: false };
    },

    async list(tx, viewer, query) {
      const scope = await visibility(tx, viewer);
      const status = query.status ?? 'open';
      const where = and(
        eq(worklistItem.status, status),
        ...(query.kind ? [eq(worklistItem.kind, query.kind)] : []),
        ...(scope ? [scope] : []),
      );
      const rows = await tx
        .select()
        .from(worklistItem)
        .where(where)
        .orderBy(asc(worklistItem.createdAt), asc(worklistItem.id))
        .limit(query.limit ?? 100);
      const [total] = await tx
        .select({ n: count() })
        .from(worklistItem)
        .where(and(eq(worklistItem.status, 'open'), ...(scope ? [scope] : [])));
      return { items: await present(tx, rows), openCount: total?.n ?? 0 };
    },

    async get(tx, viewer, id) {
      const scope = await visibility(tx, viewer);
      const [row] = await tx
        .select()
        .from(worklistItem)
        .where(and(eq(worklistItem.id, id), ...(scope ? [scope] : [])));
      const [item] = row ? await present(tx, [row]) : [];
      if (!item) throw new AppError('not_found');
      return item;
    },

    async close(tx, input) {
      const scope = await visibility(tx, input.viewer);
      const [row] = await tx
        .select()
        .from(worklistItem)
        .where(and(eq(worklistItem.id, input.id), ...(scope ? [scope] : [])))
        .for('update');
      // An item of another location looks like one that does not exist.
      if (!row) throw new AppError('not_found');
      if (row.status !== 'open') throw new AppError('conflict');
      if (
        (row.kind === 'identity_review' || row.kind === 'pending_approval') &&
        input.viaIdentityAction !== true
      ) {
        throw new AppError('conflict');
      }

      const [closed] = await tx
        .update(worklistItem)
        .set({
          status: input.status,
          resolution: input.resolution,
          resolvedAt: new Date(),
          resolvedBy: input.actor.userId,
        })
        .where(eq(worklistItem.id, row.id))
        .returning();
      if (!closed) throw new AppError('not_found');
      await audit(tx, {
        action: input.status === 'resolved' ? 'worklist.resolved' : 'worklist.dismissed',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'worklist_item',
        resourceId: row.id,
        metadata: { kind: row.kind, resolution: input.resolution },
      });
      const [item] = await present(tx, [closed]);
      if (!item) throw new Error('closed worklist item could not be presented');
      return item;
    },

    async closeBySubject(tx, input) {
      const [row] = await tx
        .update(worklistItem)
        .set({
          status: input.status,
          resolution: input.resolution,
          resolvedAt: new Date(),
          resolvedBy: input.actor.userId,
        })
        .where(
          and(
            eq(worklistItem.kind, input.kind),
            eq(worklistItem.subjectType, input.subjectType),
            eq(worklistItem.subjectId, input.subjectId),
            eq(worklistItem.status, 'open'),
          ),
        )
        .returning({ id: worklistItem.id });
      if (!row) return;
      await audit(tx, {
        action: input.status === 'resolved' ? 'worklist.resolved' : 'worklist.dismissed',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'worklist_item',
        resourceId: row.id,
        metadata: { kind: input.kind, resolution: input.resolution },
      });
    },
  };
}
