import type { ExportContributor } from '../../tenancy/index.js';

/**
 * Administrative export part owned by notifications (reminders, confirmations and offers over email and WhatsApp). Nothing is stored yet, so the part is empty;
 * the messaging track (track A, S3.01 to S3.06) fills it in when it adds its tables.
 */
export const exportNotifications: ExportContributor = () => Promise.resolve({});
