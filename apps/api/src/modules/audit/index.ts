/**
 * Public API of the audit module: the viewer, the patient access report and the export of the
 * trail. Writing the trail is a platform concern (`platform/audit`); this module only reads it.
 * Other modules and the composition root import from here only.
 */
import { asc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import { auditEvent } from '../../db/schema/audit.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { ExportContributor, ExportRegistry } from '../tenancy/index.js';

import { createAuditLogService } from './application/audit-log.js';
import { auditRoutes } from './http/audit-routes.js';

/**
 * Administrative export part owned by audit: the metadata of the trail (never any content, since
 * the trail holds none). Chain hashes are left out; they belong to the integrity verification.
 */
const exportAuditTrail: ExportContributor = async ({ tx }) => {
  const events = await tx
    .select({
      occurredAt: auditEvent.occurredAt,
      actorUserId: auditEvent.actorUserId,
      actingRole: auditEvent.actingRole,
      action: auditEvent.action,
      resourceType: auditEvent.resourceType,
      resourceId: auditEvent.resourceId,
      patientId: auditEvent.patientId,
      outcome: auditEvent.outcome,
      reason: auditEvent.reason,
      metadata: auditEvent.metadata,
    })
    .from(auditEvent)
    .orderBy(asc(auditEvent.occurredAt), asc(auditEvent.id));
  return { auditEvents: events };
};

/** Registers what audit contributes to the cancellation export. */
export function registerAuditExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'audit', exportAuditTrail);
}

export interface AuditOptions {
  withTenant: WithTenant;
}

export interface Audit {
  routes: (app: FastifyInstance) => void;
}

export function createAudit(options: AuditOptions): Audit {
  const registered = auditRoutes({
    withTenant: options.withTenant,
    auditLog: createAuditLogService(),
  });
  return {
    routes: (app) => {
      registered(app);
    },
  };
}
