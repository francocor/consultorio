import type { ExportContributor } from '../../tenancy/index.js';

/**
 * Administrative export part owned by waitlist (waiting entries and the offers of freed slots). Nothing is stored yet, so the part is empty;
 * the waitlist track (track C, S3.11 to S3.13) fills it in when it adds its tables.
 */
export const exportWaitlist: ExportContributor = () => Promise.resolve({});
