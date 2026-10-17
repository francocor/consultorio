/**
 * Public API of the clinical module: encounter notes, templates, addenda, history, the per-patient
 * timeline and search. Other modules and the composition root import from here only.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';

import { createAmendmentService } from './application/amendments.js';
import { createNoteService } from './application/notes.js';
import { amendmentRoutes } from './http/amendment-routes.js';
import { noteRoutes } from './http/note-routes.js';

export interface ClinicalOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** Envelope encryption: every note, version and addendum is stored encrypted. */
  keys: TenantKeys;
}

export interface Clinical {
  routes: (app: FastifyInstance) => void;
}

export function createClinical(options: ClinicalOptions): Clinical {
  const deps = { withTenant: options.withTenant, auditDeny: options.auditDeny };
  const notes = noteRoutes({ ...deps, notes: createNoteService({ keys: options.keys }) });
  const amendments = amendmentRoutes({
    ...deps,
    amendments: createAmendmentService({ keys: options.keys }),
  });

  return {
    routes: (app) => {
      notes(app);
      amendments(app);
    },
  };
}
