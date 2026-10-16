import { registerAccessExportContributors } from '../modules/access/index.js';
import { registerIdentityExportContributors } from '../modules/identity/index.js';
import { registerStaffExportContributors } from '../modules/staff/index.js';
import {
  registerTenancyExportContributors,
  type ExportRegistry,
} from '../modules/tenancy/index.js';

/**
 * Composition root for the export registry: every module that owns exportable data registers its
 * contributor here. `export-registry.test.ts` fails when a directory under `modules/` is missing.
 */
export function registerAllExportContributors(registry: ExportRegistry): void {
  registerTenancyExportContributors(registry);
  registerIdentityExportContributors(registry);
  registerAccessExportContributors(registry);
  registerStaffExportContributors(registry);
}
