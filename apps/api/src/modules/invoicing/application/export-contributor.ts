import type { ExportContributor } from '../../tenancy/index.js';

/**
 * Administrative export part owned by invoicing (fiscal profile, points of sale, invoices and
 * credit notes; never the certificate or its key). Nothing is stored yet, so the part is empty; the
 * invoicing track (Track C, S4.08 to S4.10) fills it in when it adds its tables.
 */
export const exportInvoicing: ExportContributor = () => Promise.resolve({});
