import {
  AR_VALIDATION_MESSAGES_ES_AR,
  ERROR_CATALOG,
  PASSWORD_ISSUE_KEYS,
} from '@consultorio/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../shared/lib/api-client.js';

import { createI18n, describeError, translateApiKey } from './i18n.js';

describe('i18n catalog', () => {
  it('has an es-AR message for every error code of the API', () => {
    const i18n = createI18n();

    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      const text = translateApiKey(i18n.t, entry.i18nKey);
      expect(text, code).not.toBe(entry.i18nKey);
      expect(text.length, code).toBeGreaterThan(8);
    }
  });

  it('has a message for each password rule, for the generic field error and for local errors', () => {
    const i18n = createI18n();
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
    const i18n = createI18n();

    for (const [key, message] of Object.entries(AR_VALIDATION_MESSAGES_ES_AR)) {
      expect(translateApiKey(i18n.t, key), key).toBe(message);
    }
  });

  it('reports a key without a translation instead of showing it silently', () => {
    const onMissing = vi.fn();
    const i18n = createI18n({ onMissing });

    const text = translateApiKey(i18n.t, 'ghost.never_translated');

    expect(onMissing).toHaveBeenCalledWith('ghost.never_translated');
    expect(text).toBe(i18n.t('errors:unexpected_response'));
  });

  it('keeps interpolation and plurals working', () => {
    const i18n = createI18n();

    expect(i18n.t('common:pagination.results', { count: 1 })).toBe('1 resultado');
    expect(i18n.t('common:pagination.results', { count: 12 })).toBe('12 resultados');
  });
});

describe('describeError', () => {
  it('uses the message of the error code and keeps the request id for support', () => {
    const i18n = createI18n();
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
    const i18n = createI18n();

    const described = describeError(i18n.t, new Error('ECONNRESET at 10.0.0.4:5432'));

    expect(described.message).toBe(i18n.t('errors:internal_error'));
    expect(described.message).not.toContain('ECONNRESET');
    expect(described.requestId).toBeNull();
  });
});
