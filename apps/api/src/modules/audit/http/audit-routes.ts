import { Readable } from 'node:stream';

import {
  AccessReportQuery,
  AuditExportQuery,
  AuditListResponse,
  AuditQuery,
  type AuditEventDto,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { AuditLogService } from '../application/audit-log.js';
import { csvRow } from '../domain/csv.js';

export interface AuditRoutesDeps {
  withTenant: WithTenant;
  auditLog: AuditLogService;
}

const PatientParams = z.strictObject({ id: z.uuid() });

const CSV_HEADER = [
  'occurred_at',
  'actor_user_id',
  'actor_name',
  'acting_role',
  'action',
  'resource_type',
  'resource_id',
  'patient_id',
  'outcome',
  'reason',
  'ip',
  'request_id',
  'sealed',
  'metadata',
] as const;

function csvLine(event: AuditEventDto): string {
  return csvRow([
    event.occurredAt,
    event.actorUserId,
    event.actorName,
    event.actingRole,
    event.action,
    event.resourceType,
    event.resourceId,
    event.patientId,
    event.outcome,
    event.reason,
    event.ip,
    event.requestId,
    event.sealed,
    JSON.stringify(event.metadata),
  ]);
}

/**
 * The audit viewer, the access report of a patient and the export. Owners and admins only
 * (`audit.read`, `audit.export`): they see who did what and when, and never the content of
 * clinical records, because the trail does not hold any.
 */
export function auditRoutes(deps: AuditRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/audit-events',
      {
        config: { readOnly: 'read', permission: 'audit.read' },
        schema: { querystring: AuditQuery, response: { 200: AuditListResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const { limit, cursor, ...filters } = request.query;
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.auditLog.list(tx, { filters, order: 'newest_first', limit, cursor }),
        );
      },
    );

    typed.get(
      '/patients/:id/access-report',
      {
        config: { readOnly: 'read', permission: 'audit.read' },
        schema: {
          params: PatientParams,
          querystring: AccessReportQuery,
          response: { 200: AuditListResponse },
        },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.auditLog.accessReport(tx, {
            patientId: request.params.id,
            limit: request.query.limit,
            cursor: request.query.cursor,
          }),
        );
      },
    );

    typed.get(
      '/audit-events/export',
      {
        // An export is on the read-only allowlist: a lapsed organization can still take its data.
        config: { readOnly: 'export', permission: 'audit.export', audits: ['audit.exported'] },
        schema: { querystring: AuditExportQuery },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const { format, ...filters } = request.query;
        const context = { tenantId: actor.tenantId, userId: actor.userId };

        // The entry is written, and committed, before the first byte leaves: no export goes
        // unrecorded, and one that cannot be recorded does not start.
        await deps.withTenant(context, (tx) =>
          deps.auditLog.recordExport(tx, {
            actor: { ...request.auditActor, userId: actor.userId },
            format,
            query: request.query,
          }),
        );

        const day = new Date().toISOString().slice(0, 10);
        void reply
          .header('cache-control', 'no-store')
          .header('content-disposition', `attachment; filename="audit-${day}.${format}"`)
          .type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');

        async function* body(): AsyncGenerator<string> {
          if (format === 'csv') {
            yield csvRow(CSV_HEADER);
          } else {
            yield '{"events":[';
          }
          let first = true;
          for await (const page of deps.auditLog.pages(deps.withTenant, context, filters)) {
            for (const event of page) {
              if (format === 'csv') {
                yield csvLine(event);
              } else {
                yield `${first ? '' : ','}${JSON.stringify(event)}`;
                first = false;
              }
            }
          }
          if (format === 'json') yield ']}';
        }
        return reply.send(Readable.from(body(), { objectMode: false }));
      },
    );
  };
}
