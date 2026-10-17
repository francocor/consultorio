import type { ExportContributor } from '../../tenancy/index.js';

/**
 * Administrative export part owned by billing (prices, charges, payments, cash sessions). Nothing is
 * stored yet, so the part is empty; the billing track (Track A, S4.05, task 4.26) fills it in when
 * it adds its tables.
 */
export const exportBilling: ExportContributor = () => Promise.resolve({});
