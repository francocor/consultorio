import type { ExportContributor } from '../../tenancy/index.js';

/**
 * Administrative export part owned by teleconsultation (video links for virtual appointments). Nothing is stored yet, so the part is empty;
 * the teleconsultation track (track D, S3.14 and S3.15) fills it in when it adds its tables.
 */
export const exportTeleconsultation: ExportContributor = () => Promise.resolve({});
