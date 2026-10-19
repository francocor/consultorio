import type { ExportContributor } from '../../tenancy/index.js';

/**
 * The reports module owns no data: every figure is derived from the records of other modules, which
 * those modules export. The contributor exists so that the cancellation export lists the module
 * and a test can tell a forgotten registration from a module that has nothing to hand over.
 */
export const exportReports: ExportContributor = () => Promise.resolve({});
