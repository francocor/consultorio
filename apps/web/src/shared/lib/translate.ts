import type { TFunction } from 'i18next';

import { isApiError } from './api-client.js';

export type Namespace = string;

/**
 * The namespaces that are loaded: one per file of `locales/es-AR` (see `locale-files.ts`), plus the
 * country validators. Each i18n instance registers the ones it is given, so the namespaces of the
 * second part of the catalog (`loadRemainingCatalogs`) count from the moment they arrive.
 */
const KNOWN_NAMESPACES = new Set<Namespace>(['country']);

export function registerNamespaces(namespaces: Iterable<Namespace>): void {
  for (const namespace of namespaces) KNOWN_NAMESPACES.add(namespace);
}

const MISSING = '\u0000missing';

function isNamespace(value: string | undefined): value is Namespace {
  return value !== undefined && KNOWN_NAMESPACES.has(value);
}

/**
 * Translates a key as the API or a schema sends it (`errors.forbidden`, `auth.password.too_short`,
 * `country.ar.national_id.invalid`, `validation.required`). A key nobody translated is reported
 * and replaced by a calm generic message: raw keys are never shown to people.
 */
export function translateApiKey(t: TFunction, key: string): string {
  const [first, ...rest] = key.split('.');
  const mapped = isNamespace(first) && rest.length > 0 ? `${first}:${rest.join('.')}` : key;
  const text = t(mapped, { defaultValue: MISSING });
  return text === MISSING ? t('errors:unexpected_response') : text;
}

export interface DescribedError {
  message: string;
  /** For support: shown next to the message so a person can quote it. */
  requestId: string | null;
}

/** Turns anything that was thrown into text a person can act on, without technical detail. */
export function describeError(t: TFunction, error: unknown): DescribedError {
  if (isApiError(error)) {
    return { message: translateApiKey(t, error.i18nKey), requestId: error.requestId };
  }
  return { message: t('errors:internal_error'), requestId: null };
}
