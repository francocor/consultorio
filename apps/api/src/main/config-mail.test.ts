import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://app_rw:placeholder@localhost:5432/app',
  BASE_DOMAIN: 'consultorio.test',
  PLATFORM_HOST: 'platform.consultorio.test',
  KMS_LOCAL_KEK_BASE64: Buffer.alloc(32, 7).toString('base64'),
};

const production = {
  ...base,
  NODE_ENV: 'production',
  ADDRESS_HASH_PEPPER: 'placeholder-pepper-0123456789-abcdefghij',
  KMS_PROVIDER: 'aws',
  AWS_REGION: 'sa-east-1',
  AWS_KMS_KEY_ID: 'alias/consultorio',
};

describe('mail configuration', () => {
  it('is absent when SMTP_HOST is not set (development without a mail server)', () => {
    expect(loadConfig(base).mail).toBeUndefined();
  });

  it('reads Mailpit settings for local development', () => {
    const config = loadConfig({ ...base, SMTP_HOST: 'localhost', SMTP_PORT: '1025' });

    expect(config.mail).toEqual({
      host: 'localhost',
      port: 1025,
      security: 'none',
      from: 'Consulvia <no-responder@localhost>',
    });
  });

  it('reads SES SMTP settings with STARTTLS and credentials', () => {
    const config = loadConfig({
      ...production,
      SMTP_HOST: 'email-smtp.sa-east-1.amazonaws.com',
      SMTP_PORT: '587',
      SMTP_SECURITY: 'starttls',
      SMTP_USER: 'AKIAEXAMPLE',
      SMTP_PASSWORD: 'secret-value',
      MAIL_FROM: 'Consultorio <no-responder@consultorio.example>',
    });

    expect(config.mail).toEqual({
      host: 'email-smtp.sa-east-1.amazonaws.com',
      port: 587,
      security: 'starttls',
      user: 'AKIAEXAMPLE',
      password: 'secret-value',
      from: 'Consultorio <no-responder@consultorio.example>',
    });
  });

  it('is required in production', () => {
    expect(() => loadConfig(production)).toThrow(ConfigError);
    expect(() => loadConfig(production)).toThrow(/SMTP_HOST/);
  });

  it('refuses a production mail server without transport security', () => {
    expect(() =>
      loadConfig({ ...production, SMTP_HOST: 'smtp.example', SMTP_SECURITY: 'none' }),
    ).toThrow(/SMTP_SECURITY/);
  });

  it('needs the user and the password together, and never prints them in an error', () => {
    let message = '';
    try {
      loadConfig({ ...base, SMTP_HOST: 'localhost', SMTP_USER: 'someone' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toMatch(/SMTP_PASSWORD/);
    expect(message).not.toContain('someone');
  });

  it.each([
    ['an unknown security mode', { SMTP_SECURITY: 'maybe' }, /SMTP_SECURITY/],
    ['a port out of range', { SMTP_PORT: '70000' }, /SMTP_PORT/],
    ['a sender that is not an address', { MAIL_FROM: 'nobody' }, /MAIL_FROM/],
  ])('refuses %s', (_label, extra, pattern) => {
    expect(() => loadConfig({ ...base, SMTP_HOST: 'localhost', ...extra })).toThrow(pattern);
  });
});
