import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AR_VALIDATION_MESSAGES_ES_AR,
  ERROR_CATALOG,
  PASSWORD_ISSUE_KEYS,
} from '@consultorio/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../shared/lib/api-client.js';
import { LOCALE_RESOURCES } from '../shared/lib/locale-all.js';

import { createI18n, describeError, loadRemainingCatalogs, translateApiKey } from './i18n.js';

describe('i18n catalog', () => {
  it('has an es-AR message for every error code of the API', () => {
    const i18n = createI18n({ resources: LOCALE_RESOURCES });

    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      const text = translateApiKey(i18n.t, entry.i18nKey);
      expect(text, code).not.toBe(entry.i18nKey);
      expect(text.length, code).toBeGreaterThan(8);
    }
  });

  it('has a message for each password rule, for the generic field error and for local errors', () => {
    const i18n = createI18n({ resources: LOCALE_RESOURCES });
    const keys = [
      ...PASSWORD_ISSUE_KEYS,
      'errors.field_invalid',
      'errors.network',
      'errors.unexpected_response',
    ];

    for (const key of keys) {
      expect(translateApiKey(i18n.t, key), key).not.toBe(key);
    }
  });

  it('translates the Argentine validator keys with the texts the contracts ship', () => {
    const i18n = createI18n({ resources: LOCALE_RESOURCES });

    for (const [key, message] of Object.entries(AR_VALIDATION_MESSAGES_ES_AR)) {
      expect(translateApiKey(i18n.t, key), key).toBe(message);
    }
  });

  it('reports a key without a translation instead of showing it silently', () => {
    const onMissing = vi.fn();
    const i18n = createI18n({ onMissing, resources: LOCALE_RESOURCES });

    const text = translateApiKey(i18n.t, 'ghost.never_translated');

    expect(onMissing).toHaveBeenCalledWith('ghost.never_translated');
    expect(text).toBe(i18n.t('errors:unexpected_response'));
  });

  it('keeps interpolation and plurals working', () => {
    const i18n = createI18n({ resources: LOCALE_RESOURCES });

    expect(i18n.t('common:pagination.results', { count: 1 })).toBe('1 resultado');
    expect(i18n.t('common:pagination.results', { count: 12 })).toBe('12 resultados');
  });
});

describe('describeError', () => {
  it('uses the message of the error code and keeps the request id for support', () => {
    const i18n = createI18n({ resources: LOCALE_RESOURCES });
    const error = new ApiError({
      status: 403,
      kind: 'problem',
      code: 'forbidden',
      i18nKey: 'errors.forbidden',
      requestId: 'req-77',
    });

    const described = describeError(i18n.t, error);

    expect(described.message).toBe(i18n.t('errors:forbidden'));
    expect(described.requestId).toBe('req-77');
  });

  it('never shows technical detail for an unknown thrown value', () => {
    const i18n = createI18n({ resources: LOCALE_RESOURCES });

    const described = describeError(i18n.t, new Error('ECONNRESET at 10.0.0.4:5432'));

    expect(described.message).toBe(i18n.t('errors:internal_error'));
    expect(described.message).not.toContain('ECONNRESET');
    expect(described.requestId).toBeNull();
  });
});

describe('the catalogs that arrive after the first bundle', () => {
  const keyOf = (namespace: string) => Object.keys(LOCALE_RESOURCES[namespace] ?? {})[0] ?? '';
  const billingError =
    Object.keys(
      JSON.parse(
        readFileSync(resolve(import.meta.dirname, '../locales/es-AR/errors.billing.json'), 'utf8'),
      ) as Record<string, string>,
    )[0] ?? '';

  it('starts with what the sign-in page shows and nothing of the features', () => {
    const i18n = createI18n();

    expect(i18n.exists('common:pagination.results_one')).toBe(true);
    expect(i18n.exists(`auth:${keyOf('auth')}`)).toBe(true);
    expect(i18n.exists('errors:forbidden')).toBe(true);
    expect(i18n.exists(`scheduling:${keyOf('scheduling')}`)).toBe(false);
    expect(i18n.exists(`errors:${billingError}`)).toBe(false);
  });

  it('adds the texts of the features and the error codes of the modules once they are loaded', async () => {
    const i18n = createI18n();

    await loadRemainingCatalogs(i18n);

    expect(i18n.exists(`scheduling:${keyOf('scheduling')}`)).toBe(true);
    expect(i18n.exists(`errors:${billingError}`)).toBe(true);
    // The base of the namespace is still there: the two parts were joined, not replaced.
    expect(i18n.exists('errors:forbidden')).toBe(true);
  });

  it('fetches the chunk once per instance, however many frames ask', async () => {
    const i18n = createI18n();

    const first = loadRemainingCatalogs(i18n);
    const second = loadRemainingCatalogs(i18n);
    await first;

    expect(second).toBe(first);
  });

  it('keeps the catalogs of an instance that started with all of them', async () => {
    const i18n = createI18n({ resources: LOCALE_RESOURCES });

    await loadRemainingCatalogs(i18n);

    expect(i18n.t('common:pagination.results_one', { count: 1 })).toBe(
      createI18n({ resources: LOCALE_RESOURCES }).t('common:pagination.results_one', { count: 1 }),
    );
  });
});
