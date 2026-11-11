import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://app_rw:placeholder@localhost:5432/app',
  BASE_DOMAIN: 'consultorio.test',
  PLATFORM_HOST: 'platform.consultorio.test',
  KMS_LOCAL_KEK_BASE64: Buffer.alloc(32, 7).toString('base64'),
};

describe('account lockout configuration', () => {
  it('defaults to 10 failures and a 15 minute lock', () => {
    expect(loadConfig(base).lockout).toEqual({ maxFailures: 10, lockMs: 15 * 60_000 });
  });

  it('can be tuned', () => {
    const config = loadConfig({
      ...base,
      AUTH_LOCKOUT_MAX_FAILURES: '5',
      AUTH_LOCKOUT_MINUTES: '30',
    });

    expect(config.lockout).toEqual({ maxFailures: 5, lockMs: 30 * 60_000 });
  });

  it.each([
    ['zero failures', { AUTH_LOCKOUT_MAX_FAILURES: '0' }, /AUTH_LOCKOUT_MAX_FAILURES/],
    [
      'too many failures to be a lock',
      { AUTH_LOCKOUT_MAX_FAILURES: '500' },
      /AUTH_LOCKOUT_MAX_FAILURES/,
    ],
    ['a fractional count', { AUTH_LOCKOUT_MAX_FAILURES: '2.5' }, /AUTH_LOCKOUT_MAX_FAILURES/],
    ['a lock of no time', { AUTH_LOCKOUT_MINUTES: '0' }, /AUTH_LOCKOUT_MINUTES/],
    ['a lock of more than a day', { AUTH_LOCKOUT_MINUTES: '5000' }, /AUTH_LOCKOUT_MINUTES/],
    ['text', { AUTH_LOCKOUT_MINUTES: 'soon' }, /AUTH_LOCKOUT_MINUTES/],
  ])('refuses %s and names the variable', (_label, extra, pattern) => {
    expect(() => loadConfig({ ...base, ...extra })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, ...extra })).toThrow(pattern);
  });
});
