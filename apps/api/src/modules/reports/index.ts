/**
 * Public API of the reports module (operational, financial and cash reports). Other modules and the
 * composition root import from here only.
 *
 * This is the seam skeleton of Stage 4: the module is wired and registered, and does nothing yet.
 * The reports track (Track B, S4.06, S4.07 and S4.14) adds files under this folder and edits this
 * one. The module reads billing and invoicing records only through their `index.ts`, never their
 * tables.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportReports } from './application/export-contributor.js';

/** Registers the (empty) administrative part of reports: the module owns no data. */
export function registerReportsExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'reports', exportReports);
}

export interface ReportsOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  clock?: () => Date;
}

export interface Reports {
  /** What the module was built with; the track builds its services from it. */
  readonly options: ReportsOptions;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createReports(options: ReportsOptions): Reports {
  return { options, routes: () => undefined };
}
