/**
 * Public API of the reports module (operational, financial and cash reports). Other modules and the
 * composition root import from here only.
 *
 * Stage 4, Track B. The operational report and its drill-down are here (S4.06); the financial
 * and cash reports (S4.14) join them. The module owns no tables: every figure is read from the
 * records of scheduling, the waitlist, billing and invoicing through their `index.ts`, never their
 * tables, and cut to what the viewer may see by `application/scope.ts`.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportReports } from './application/export-contributor.js';
import { reportRoutes } from './http/report-routes.js';

/** Registers the (empty) administrative part of reports: the module owns no data. */
export function registerReportsExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'reports', exportReports);
}

export interface ReportsOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** Reads the working hours of the professionals (occupancy) through the scheduling ports. */
  keys: TenantKeys;
  clock?: () => Date;
}

export interface Reports {
  /** What the module was built with; the track builds its services from it. */
  readonly options: ReportsOptions;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createReports(options: ReportsOptions): Reports {
  const routes = reportRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    keys: options.keys,
    clock: options.clock ?? (() => new Date()),
  });
  return { options, routes };
}
