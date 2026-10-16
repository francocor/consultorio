/**
 * Public API of the patients module: the registry (demographics, deduplication, search, history).
 * Other modules and the composition root import from here only.
 */
import type { FastifyInstance } from 'fastify';

import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { createAnamnesisService } from './application/anamnesis.js';
import { createAssignmentService } from './application/assignments.js';
import { createConsentService } from './application/consent.js';
import { createCoverageService } from './application/coverage.js';
import { exportPatients } from './application/export-contributor.js';
import { createPatientService, type DocumentRules } from './application/patients.js';
import { createRepresentativeService } from './application/representatives.js';
import { createRightsService } from './application/rights.js';
import { anamnesisRoutes } from './http/anamnesis-routes.js';
import { assignmentRoutes } from './http/assignment-routes.js';
import { consentRoutes } from './http/consent-routes.js';
import { coverageRoutes } from './http/coverage-routes.js';
import { patientRoutes } from './http/patient-routes.js';
import { representativeRoutes } from './http/representative-routes.js';
import { rightsRoutes } from './http/rights-routes.js';

/** Registers what patients contributes to the cancellation export. */
export function registerPatientsExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'patients', exportPatients);
}

export { hasDataProcessingConsent } from './application/consent.js';
export type { DocumentRules } from './application/patients.js';

export interface PatientsOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** Identity document rules of the organization's country (from its country pack). */
  documents: DocumentRules;
  /** Age at which a person is no longer a minor, from the country pack. */
  majorityAge: (country: string) => number;
  /** Envelope encryption: the anamnesis is stored encrypted with the tenant data key. */
  keys: TenantKeys;
  /** Key and version of the data-processing consent text, from the country pack. */
  consentText: (country: string) => { textKey: string; version: string };
  clock?: () => Date;
}

export interface Patients {
  routes: (app: FastifyInstance) => void;
}

export function createPatients(options: PatientsOptions): Patients {
  const clock = options.clock ? { clock: options.clock } : {};
  const representatives = createRepresentativeService({
    majorityAge: options.majorityAge,
    ...clock,
  });
  const consent = createConsentService({ textFor: options.consentText });
  const patients = createPatientService({
    documents: options.documents,
    representatives,
    consent,
    ...clock,
  });
  const registry = patientRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    patients,
  });

  const contacts = representativeRoutes({ withTenant: options.withTenant, representatives });
  const consentEndpoints = consentRoutes({ withTenant: options.withTenant, consent });
  const clinical = anamnesisRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    anamnesis: createAnamnesisService({ keys: options.keys }),
  });
  const assignments = assignmentRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    assignments: createAssignmentService(),
  });
  const coverageService = createCoverageService(clock);
  const coverage = coverageRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    coverage: coverageService,
  });
  const rights = rightsRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    rights: createRightsService({
      patients,
      coverage: coverageService,
      consent,
      representatives,
      ...clock,
    }),
  });

  return {
    routes: (app) => {
      registry(app);
      contacts(app);
      coverage(app);
      consentEndpoints(app);
      rights(app);
      clinical(app);
      assignments(app);
    },
  };
}
