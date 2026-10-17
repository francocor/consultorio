import { registerAccessExportContributors } from '../modules/access/index.js';
import { registerAuditExportContributors } from '../modules/audit/index.js';
import { registerClinicalExportContributors } from '../modules/clinical/index.js';
import { registerDocumentsExportContributors } from '../modules/documents/index.js';
import { registerIdentityExportContributors } from '../modules/identity/index.js';
import { registerOnboardingExportContributors } from '../modules/onboarding/index.js';
import { registerPatientsExportContributors } from '../modules/patients/index.js';
import { registerSchedulingExportContributors } from '../modules/scheduling/index.js';
import { registerStaffExportContributors } from '../modules/staff/index.js';
import {
  registerTenancyExportContributors,
  type ExportRegistry,
} from '../modules/tenancy/index.js';
import type { TenantKeys } from '../platform/crypto/tenant-keys.js';

/**
 * Composition root for the export registry: every module that owns exportable data registers its
 * contributor here. `export-registry.test.ts` fails when a directory under `modules/` is missing.
 */
export function registerAllExportContributors(
  registry: ExportRegistry,
  deps: { keys?: TenantKeys } = {},
): void {
  registerTenancyExportContributors(registry);
  registerIdentityExportContributors(registry);
  registerAccessExportContributors(registry);
  registerStaffExportContributors(registry);
  registerPatientsExportContributors(registry);
  registerSchedulingExportContributors(registry);
  registerDocumentsExportContributors(registry);
  registerOnboardingExportContributors(registry);
  registerAuditExportContributors(registry);
  registerClinicalExportContributors(registry, deps);
}
