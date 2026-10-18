import {
  OperationalReportResponse,
  REPORT_MAX_SPAN_DAYS,
  ReportFilters,
  ReportOptionsResponse,
  ReportRecordsQuery,
  ReportRecordsResponse,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { audit } from '../../../platform/audit/writer.js';
import type { Actor } from '../../../platform/authz/actor.js';
import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused, createLocationService, visibleLocationIds } from '../../access/index.js';
import { reportProfessionals } from '../../scheduling/index.js';
import { cohortScope, operationalRecords, operationalReport } from '../application/operational.js';
import {
  canSeeRevenueByProfessional,
  checkFilters,
  resolveScope,
  type ReportScope,
} from '../application/scope.js';
import { rangeProblems } from '../domain/filters.js';

export interface ReportRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  keys: TenantKeys;
  clock: () => Date;
}

const RESOURCE = 'report';

/** What a request knows about who acts, from the session and never from the query. */
function requestActor(request: FastifyRequest) {
  const actor = request.actor;
  if (!actor) throw new AppError('unauthenticated');
  return {
    actor,
    audit: { ...request.auditActor, userId: actor.userId },
    context: { tenantId: actor.tenantId, userId: actor.userId },
  };
}

/** Who may read what, resolved in the transaction of the request (the membership's locations). */
async function scopeOf(tx: Tx, actor: Actor): Promise<ReportScope> {
  const viewer = { roles: actor.roles, membershipId: actor.membershipId };
  const visible = await visibleLocationIds(tx, viewer);
  const scope = resolveScope({
    kind: actor.kind,
    roles: actor.roles,
    professionalId: actor.ownProfessionalId ?? actor.professionalId,
    assignedLocationIds: visible === 'all' ? [] : visible,
  });
  if (!scope) throw new AccessRefused('no_report_scope');
  return scope;
}

/** A range that is inverted or too long never runs: the answer names the field and the reason. */
function assertRange(filters: ReportFilters): void {
  const problems = rangeProblems(filters);
  if (problems.length > 0) throw new AppError('validation_failed', problems);
}

function assertFilters(scope: ReportScope, filters: ReportFilters): void {
  const check = checkFilters(scope, filters);
  if (!check.ok) throw new AccessRefused(check.reason);
}

/**
 * The reports of Stage 4 (reports-dashboard). Every route needs `reports.read` and is a read, so a
 * tenant in read-only state still gets them. The scope of the viewer (`application/scope.ts`) is
 * applied on the server for every route; a filter can narrow a report, never widen it.
 */
export function reportRoutes(deps: ReportRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // A report is not a record with an id: the audit entry names it in its metadata.
    const refuse = (request: FastifyRequest, error: AccessRefused, report: string) =>
      refuseRequest(deps.auditDeny, request, {
        reason: error.reason,
        resourceType: RESOURCE,
        metadata: { report },
      });

    typed.get(
      '/reports/options',
      {
        config: { readOnly: 'read', permission: 'reports.read' },
        schema: { response: { 200: ReportOptionsResponse } },
      },
      async (request) => {
        const { actor, context } = requestActor(request);
        try {
          return await deps.withTenant(context, async (tx) => {
            const scope = await scopeOf(tx, actor);
            // Locations are not sensitive: a professional chooses among all of them (their own
            // appointments can be anywhere); reception among the ones it works at.
            const viewer = {
              roles: scope.kind === 'locations' ? actor.roles : (['admin'] as const),
              membershipId: actor.membershipId,
            };
            const locations = await createLocationService().list(tx, viewer, {
              includeInactive: false,
            });
            const professionals = await reportProfessionals(tx, cohortScope(scope));
            return {
              scope: scope.kind,
              locations: locations.map(({ id, name }) => ({ id, name })),
              professionals: professionals.map(({ id, name }) => ({ id, name })),
              specialties: [...new Set(professionals.flatMap((row) => row.specialties))].sort(
                (a, b) => a.localeCompare(b, 'es'),
              ),
              canSeeRevenueByProfessional: canSeeRevenueByProfessional(scope),
              maxSpanDays: REPORT_MAX_SPAN_DAYS,
            };
          });
        } catch (error) {
          if (error instanceof AccessRefused) return await refuse(request, error, 'options');
          throw error;
        }
      },
    );

    typed.get(
      '/reports/operational',
      {
        config: { readOnly: 'read', permission: 'reports.read' },
        schema: { querystring: ReportFilters, response: { 200: OperationalReportResponse } },
      },
      async (request) => {
        const { actor, context } = requestActor(request);
        assertRange(request.query);
        try {
          return await deps.withTenant(context, async (tx) => {
            const scope = await scopeOf(tx, actor);
            assertFilters(scope, request.query);
            return operationalReport(tx, { scope, filters: request.query }, deps);
          });
        } catch (error) {
          if (error instanceof AccessRefused) return await refuse(request, error, 'operational');
          throw error;
        }
      },
    );

    // The appointments behind a figure. They show the patient's name, so every read is audited.
    typed.get(
      '/reports/operational/records',
      {
        config: { readOnly: 'read', permission: 'reports.read', audits: ['report.accessed'] },
        schema: { querystring: ReportRecordsQuery, response: { 200: ReportRecordsResponse } },
      },
      async (request) => {
        const { actor, audit: auditActor, context } = requestActor(request);
        assertRange(request.query);
        try {
          return await deps.withTenant(context, async (tx) => {
            const scope = await scopeOf(tx, actor);
            assertFilters(scope, request.query);
            const result = await operationalRecords(tx, { scope, query: request.query });
            await audit(tx, {
              action: 'report.accessed',
              outcome: 'allow',
              actor: auditActor,
              resourceType: RESOURCE,
              metadata: {
                report: 'operational.records',
                group: result.group,
                from: result.filters.from,
                to: result.filters.to,
                scope: result.filters.scope,
                locationId: result.filters.locationId,
                professionalId: result.filters.professionalId,
                specialty: result.filters.specialty,
                total: result.total,
                offset: result.offset,
                rows: result.records.length,
              },
            });
            return result;
          });
        } catch (error) {
          if (error instanceof AccessRefused) {
            return await refuse(request, error, 'operational.records');
          }
          throw error;
        }
      },
    );
  };
}
