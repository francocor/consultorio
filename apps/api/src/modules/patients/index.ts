/**
 * Public API of the patients module: the registry (demographics, deduplication, search, history).
 * Other modules and the composition root import from here only.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportPatients } from './application/export-contributor.js';
import { createPatientService, type DocumentRules } from './application/patients.js';
import { patientRoutes } from './http/patient-routes.js';

/** Registers what patients contributes to the cancellation export. */
export function registerPatientsExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'patients', exportPatients);
}

export type { DocumentRules } from './application/patients.js';

export interface PatientsOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** Identity document rules of the organization's country (from its country pack). */
  documents: DocumentRules;
  clock?: () => Date;
}

export interface Patients {
  routes: (app: FastifyInstance) => void;
}

export function createPatients(options: PatientsOptions): Patients {
  const patients = createPatientService({
    documents: options.documents,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const registry = patientRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    patients,
  });

  return {
    routes: (app) => {
      registry(app);
    },
  };
}
