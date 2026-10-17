/**
 * The error codes and audit actions of the reports module, apart from its schemas (see
 * `billing-catalog.ts` for why they live apart).
 */

/**
 * Error codes of the reports module, with their status and the key of the es-AR message. They join
 * the API catalog (errors.ts); the messages go in `locales/es-AR/errors.reports.json`, keyed by the
 * code. The reports track (Track B) adds its codes here and nowhere else.
 */
export const REPORTS_ERRORS = {} as const satisfies Record<
  string,
  { status: number; i18nKey: string }
>;

/** Audit actions of the reports. They are registered in the shared catalogue. */
export const REPORTS_AUDIT_ACTIONS = ['report.accessed'] as const;
