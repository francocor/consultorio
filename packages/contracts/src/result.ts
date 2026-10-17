/** Why a value was rejected. `i18nKey` is translated by the web app; the API never builds prose. */
export interface ValidationIssue {
  i18nKey: string;
}

/** Outcome of a pure validator: no exceptions for expected bad input. */
export type Result<T, E = ValidationIssue> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function fail(i18nKey: string): Result<never> {
  return { ok: false, error: { i18nKey } };
}
