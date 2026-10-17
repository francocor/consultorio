/**
 * Public API of the clinical module: encounter notes, templates, addenda, history, the per-patient
 * timeline and search. Other modules and the composition root import from here only.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { createAmendmentService } from './application/amendments.js';
import { exportClinical } from './application/export-contributor.js';
import { createNoteService } from './application/notes.js';
import { createSearchService } from './application/search.js';
import { createTimelineService } from './application/timeline.js';
import { amendmentRoutes } from './http/amendment-routes.js';
import { noteRoutes } from './http/note-routes.js';
import { templateRoutes } from './http/template-routes.js';
import { timelineRoutes } from './http/timeline-routes.js';

/**
 * Registers the clinical part of the cancellation export (one per professional). It needs the key
 * service to decrypt; without `keys` the contributor is registered but refuses to run.
 */
export function registerClinicalExportContributors(
  registry: ExportRegistry,
  deps: { keys?: TenantKeys } = {},
): void {
  registry.registerExportContributor('clinical', 'clinical', exportClinical(deps.keys));
}

export interface ClinicalOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** Envelope encryption: every note, version and addendum is stored encrypted. */
  keys: TenantKeys;
  /** Entries searched at once (default 2,000, design 4.3). Tests lower it. */
  searchCap?: number;
}

export interface Clinical {
  routes: (app: FastifyInstance) => void;
}

export function createClinical(options: ClinicalOptions): Clinical {
  const deps = { withTenant: options.withTenant, auditDeny: options.auditDeny };
  const { keys } = options;
  const notes = noteRoutes({ ...deps, notes: createNoteService({ keys }) });
  const amendments = amendmentRoutes({ ...deps, amendments: createAmendmentService({ keys }) });
  const record = timelineRoutes({
    ...deps,
    timeline: createTimelineService({ keys }),
    search: createSearchService({
      keys,
      ...(options.searchCap === undefined ? {} : { cap: options.searchCap }),
    }),
  });
  const templates = templateRoutes(deps);

  return {
    routes: (app) => {
      notes(app);
      amendments(app);
      record(app);
      templates(app);
    },
  };
}
