import { z } from 'zod';

/**
 * Error codes of the API, with the HTTP status each one is sent with and the i18n key the web app
 * translates. The catalog is the one place that pairs them, so server and client cannot drift.
 *
 * Denials are deliberately coarse: `not_found` is what a user gets for a resource that does not
 * exist AND for a tenant-scoped resource they may not see (see `denied()` in the API), so the
 * response never reveals which of the two it was.
 */
export const ERROR_CATALOG = {
  bad_request: { status: 400, i18nKey: 'errors.bad_request' },
  validation_failed: { status: 400, i18nKey: 'errors.validation_failed' },
  unauthenticated: { status: 401, i18nKey: 'errors.unauthenticated' },
  tenant_read_only: { status: 402, i18nKey: 'errors.tenant_read_only' },
  forbidden: { status: 403, i18nKey: 'errors.forbidden' },
  two_factor_required: { status: 403, i18nKey: 'errors.two_factor_required' },
  not_found: { status: 404, i18nKey: 'errors.not_found' },
  conflict: { status: 409, i18nKey: 'errors.conflict' },
  stale_revision: { status: 409, i18nKey: 'errors.stale_revision' },
  unsupported_country: { status: 422, i18nKey: 'errors.unsupported_country' },
  rate_limited: { status: 429, i18nKey: 'errors.rate_limited' },
  internal_error: { status: 500, i18nKey: 'errors.internal_error' },
} as const satisfies Record<string, { status: number; i18nKey: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export const ERROR_CODES = Object.keys(ERROR_CATALOG) as readonly ErrorCode[];

/** Fallback used when an error carries only an HTTP status (framework and validation errors). */
export function errorCodeForStatus(status: number): ErrorCode {
  if (status >= 500) return 'internal_error';
  switch (status) {
    case 400:
      return 'validation_failed';
    case 401:
      return 'unauthenticated';
    case 402:
      return 'tenant_read_only';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 429:
      return 'rate_limited';
    default:
      return 'bad_request';
  }
}

const errorCodeSchema = z.enum(ERROR_CODES as [ErrorCode, ...ErrorCode[]]);

/** One invalid field. Carries a path and a translation key, never the submitted value. */
export const FieldError = z.strictObject({
  path: z.string().min(1),
  i18nKey: z.string().min(1),
});
export type FieldError = z.infer<typeof FieldError>;

/**
 * RFC 9457 problem details, as sent by every error response (`application/problem+json`).
 * The schema is strict on purpose: nothing but these members may reach a client, so a stack, an
 * SQL fragment or a driver message cannot ride along.
 */
export const Problem = z.strictObject({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  code: errorCodeSchema,
  i18nKey: z.string().min(1),
  requestId: z.string().min(1),
  errors: z.array(FieldError).optional(),
});
export type Problem = z.infer<typeof Problem>;
