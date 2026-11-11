import { z } from 'zod';

/**
 * Pieces shared by the clinical templates. A template is a pair of schemas over the same fields:
 *
 * - the DRAFT schema accepts a partial note (the professional is still writing), but still refuses
 *   a value that is wrong in itself (a pain of 11, a tooth that does not exist);
 * - the SIGN schema also requires the fields the template defines as required and applies the
 *   rules that need the whole note (a follow-up note for a high risk, a plausible weight).
 *
 * Messages are translation keys (`validation.*` for the generic ones, `clinical.*` for a rule of a
 * template), never sentences, so the same schema serves the API and the form.
 */

export const REQUIRED = 'validation.required';

/** One invalid field of a note: where, and the translation key that says why. Never the value. */
export interface FieldIssue {
  path: string;
  i18nKey: string;
}

export type ContentResult<T = Record<string, unknown>> =
  { ok: true; content: T } | { ok: false; errors: FieldIssue[] };

/** A short text such as a name, a unit or a label. */
export function shortText(max: number) {
  return z.string().trim().min(1, REQUIRED).max(max);
}

/** Free text: may be empty while drafting, bounded so a note cannot grow without limit. */
export function freeText(max: number) {
  return z.string().trim().max(max);
}

/** The key a zod issue stands for. A schema that wrote its own `clinical.*` key keeps it. */
function issueKey(issue: z.core.$ZodIssue): string {
  if (issue.message.startsWith('clinical.') || issue.message.startsWith('validation.')) {
    return issue.message;
  }
  switch (issue.code) {
    case 'invalid_key': {
      // A key of a record that failed its own schema (an unknown tooth): use the key's message.
      const inner = issue.issues[0]?.message ?? '';
      return inner.startsWith('clinical.') ? inner : 'validation.invalid';
    }
    case 'invalid_type':
      return issue.input === undefined || issue.input === null ? REQUIRED : 'validation.invalid';
    case 'too_small':
      return issue.origin === 'string' || issue.origin === 'array'
        ? issue.minimum === 1 || issue.minimum === 1n
          ? REQUIRED
          : 'validation.too_short'
        : 'validation.too_small';
    case 'too_big':
      return issue.origin === 'string' || issue.origin === 'array'
        ? 'validation.too_long'
        : 'validation.too_big';
    default:
      return 'validation.invalid';
  }
}

/** Where an issue is, as a dotted path (`measurements.0.value`); `(root)` for the whole note. */
function issuePath(issue: z.core.$ZodIssue): string {
  if (issue.code === 'unrecognized_keys') {
    return [...issue.path, ...issue.keys.slice(0, 1)].map(String).join('.') || '(root)';
  }
  return issue.path.map(String).join('.') || '(root)';
}

/** Runs a schema over content and turns the issues into paths and keys (one per path). */
export function validateWith(schema: z.ZodType, content: unknown): ContentResult {
  const parsed = schema.safeParse(content);
  if (parsed.success) return { ok: true, content: parsed.data as Record<string, unknown> };
  const seen = new Set<string>();
  const errors: FieldIssue[] = [];
  for (const issue of parsed.error.issues) {
    const path = issuePath(issue);
    if (seen.has(path)) continue;
    seen.add(path);
    errors.push({ path, i18nKey: issueKey(issue) });
  }
  return { ok: false, errors };
}
