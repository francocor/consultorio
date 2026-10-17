export { REPORTS_ERRORS, REPORTS_AUDIT_ACTIONS } from './reports-catalog.js';

/**
 * Contracts of the reports module (operational, financial and cash reports). This file holds what
 * is certain from the design and the spec; the reports track (S4.06, S4.07, S4.14) adds its filter,
 * request and response shapes below, in this file only. The export formats are `EXPORT_FORMATS` in
 * `billing.ts`.
 */

/** A report covers at most this many days; a longer range is rejected with a clear message. */
export const REPORT_MAX_SPAN_DAYS = 366;
