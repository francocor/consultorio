import { describe, expect, it } from 'vitest';

import { BILLING_ERRORS } from './billing.js';
import {
  ERROR_CATALOG,
  ERROR_CODES,
  Problem,
  errorCodeForStatus,
  findDuplicateErrorCodes,
} from './errors.js';
import { INVOICING_ERRORS } from './invoicing.js';
import { NOTIFICATION_ERRORS } from './notifications.js';
import { ONLINE_BOOKING_ERRORS } from './online-booking.js';
import { REPORTS_ERRORS } from './reports.js';
import { TELECONSULTATION_ERRORS } from './teleconsultation.js';
import { WAITLIST_ERRORS } from './waitlist-catalog.js';

const REQUEST_ID = '0190a000-0000-7000-8000-000000000001';

describe('Problem schema (RFC 9457)', () => {
  it('accepts a minimal problem with a known code', () => {
    const fixture = {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      code: 'not_found',
      i18nKey: 'errors.not_found',
      requestId: REQUEST_ID,
    };

    expect(Problem.parse(fixture)).toEqual(fixture);
  });

  it('accepts field errors that carry only a path and an i18n key', () => {
    const fixture = {
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      code: 'validation_failed',
      i18nKey: 'errors.validation_failed',
      requestId: REQUEST_ID,
      errors: [{ path: 'patient.nationalId', i18nKey: 'errors.invalid_national_id' }],
    };

    expect(Problem.parse(fixture).errors).toEqual(fixture.errors);
  });

  it.each([
    ['an unknown code', { code: 'something_new' }],
    ['a missing request id', { requestId: undefined }],
    ['a status outside 400-599', { status: 200 }],
    ['a non-integer status', { status: 404.5 }],
    ['an empty i18n key', { i18nKey: '' }],
  ])('rejects %s', (_label, override) => {
    const fixture = {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      code: 'not_found',
      i18nKey: 'errors.not_found',
      requestId: REQUEST_ID,
      ...override,
    };

    expect(Problem.safeParse(fixture).success).toBe(false);
  });

  it('rejects extra properties that could carry internals (strict body)', () => {
    const result = Problem.safeParse({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      code: 'internal_error',
      i18nKey: 'errors.internal_error',
      requestId: REQUEST_ID,
      stack: 'at somewhere (file.ts:1:1)',
    });

    expect(result.success).toBe(false);
  });
});

describe('error catalog', () => {
  it('defines a status and an i18n key for every code, namespaced by the code', () => {
    expect(ERROR_CODES.length).toBeGreaterThan(5);
    for (const code of ERROR_CODES) {
      const entry = ERROR_CATALOG[code];
      expect(entry.i18nKey).toBe(`errors.${code}`);
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.status).toBeLessThan(600);
    }
  });

  it('keeps the read-only status at 402 as the tenancy spec requires', () => {
    expect(ERROR_CATALOG.tenant_read_only.status).toBe(402);
  });

  it.each([
    [400, 'validation_failed'],
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [429, 'rate_limited'],
    [500, 'internal_error'],
    [503, 'internal_error'],
    [418, 'bad_request'],
  ])('maps HTTP status %i to code %s', (status, code) => {
    expect(errorCodeForStatus(status)).toBe(code);
  });
});

describe('the error catalogs of the modules', () => {
  // Typed as plain catalogs: once the tracks fill them in, each one has its own literal shape.
  const modules: Record<string, Readonly<Record<string, { status: number; i18nKey: string }>>> = {
    notifications: NOTIFICATION_ERRORS,
    'online-booking': ONLINE_BOOKING_ERRORS,
    waitlist: WAITLIST_ERRORS,
    teleconsultation: TELECONSULTATION_ERRORS,
    billing: BILLING_ERRORS,
    reports: REPORTS_ERRORS,
    invoicing: INVOICING_ERRORS,
  };

  it.each(Object.entries(modules))(
    '%s has a catalog that is part of the API catalog',
    (_name, catalog) => {
      for (const [code, entry] of Object.entries(catalog)) {
        expect(ERROR_CATALOG, code).toHaveProperty(code);
        expect(entry.i18nKey, code).toBe(`errors.${code}`);
      }
    },
  );

  it('finds a code two catalogs both define, which would silently let the second one win', () => {
    const entry = { status: 409, i18nKey: 'errors.same' };

    expect(findDuplicateErrorCodes([{ same: entry }, { other: entry }])).toEqual([]);
    expect(findDuplicateErrorCodes([{ same: entry }, { same: entry }])).toEqual(['same']);
  });

  it('has no code defined by two of the catalogs that ship', () => {
    expect(findDuplicateErrorCodes([...Object.values(modules)])).toEqual([]);
  });
});
