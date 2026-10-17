import type { ExportContributor } from '../../tenancy/index.js';

/**
 * Administrative export part owned by online-booking (public booking links, holds and verified submissions). Nothing is stored yet, so the part is empty;
 * the public booking track (track B, S3.07 to S3.10) fills it in when it adds its tables.
 */
export const exportOnlineBooking: ExportContributor = () => Promise.resolve({});
