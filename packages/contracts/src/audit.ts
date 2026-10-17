import { z } from 'zod';

import { AUDIT_ACTIONS, AUDIT_OUTCOMES } from './audit-actions.js';

/**
 * Contracts of the audit viewer. An entry says who did what to which record, and when; it never
 * holds the content of what was read or written (audit-log, "Entry content"), so a non-clinical
 * administrator can see the activity around clinical records without seeing the records.
 */

const Timestamp = z.iso.datetime({ offset: true });

export const AuditQuery = z.strictObject({
  actorUserId: z.uuid().optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  outcome: z.enum(AUDIT_OUTCOMES).optional(),
  patientId: z.uuid().optional(),
  resourceType: z.string().trim().min(1).max(40).optional(),
  resourceId: z.uuid().optional(),
  /** Inclusive start and exclusive end of the period. */
  from: Timestamp.optional(),
  to: Timestamp.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export const AuditEventDto = z.strictObject({
  id: z.uuid(),
  occurredAt: z.string(),
  actorUserId: z.uuid().nullable(),
  /** How the actor is shown in the staff directory, when they have a membership. */
  actorName: z.string().nullable(),
  actingRole: z.string().nullable(),
  action: z.string(),
  resourceType: z.string().nullable(),
  resourceId: z.uuid().nullable(),
  patientId: z.uuid().nullable(),
  outcome: z.enum(AUDIT_OUTCOMES),
  reason: z.string().nullable(),
  ip: z.string().nullable(),
  requestId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  /** False while the entry waits for the sealer: it is durable and visible, not yet chained. */
  sealed: z.boolean(),
});
export type AuditEventDto = z.infer<typeof AuditEventDto>;

export const AuditListResponse = z.strictObject({
  events: z.array(AuditEventDto),
  nextCursor: z.string().nullable(),
});
export type AuditListResponse = z.infer<typeof AuditListResponse>;

/** The export takes the same filters as the list, minus the paging. */
export const AuditExportQuery = z.strictObject({
  format: z.enum(['csv', 'json']).default('csv'),
  actorUserId: AuditQuery.shape.actorUserId,
  action: AuditQuery.shape.action,
  outcome: AuditQuery.shape.outcome,
  patientId: AuditQuery.shape.patientId,
  resourceType: AuditQuery.shape.resourceType,
  resourceId: AuditQuery.shape.resourceId,
  from: AuditQuery.shape.from,
  to: AuditQuery.shape.to,
});
export type AuditExportQuery = z.infer<typeof AuditExportQuery>;

/** Who accessed a patient's record: the access report, oldest first. */
export const AccessReportQuery = z.strictObject({
  limit: AuditQuery.shape.limit,
  cursor: AuditQuery.shape.cursor,
});
export type AccessReportQuery = z.infer<typeof AccessReportQuery>;
