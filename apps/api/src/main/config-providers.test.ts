import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { PROVIDER_ENV_VARIABLES } from './config-providers.js';
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
  SMTP_HOST: 'email-smtp.sa-east-1.amazonaws.com',
  SMTP_SECURITY: 'starttls',
};

describe('provider configuration', () => {
  it('runs on the local simulators outside production and keeps the console off', () => {
    expect(loadConfig(base).providers).toEqual({
      whatsapp: 'local',
      video: 'local',
      botChallenge: 'local',
      videoAllowedDomains: [],
      allowLocalProviders: false,
      localProvidersConsole: false,
    });
  });

  it('defaults production to no simulator: WhatsApp and video off, the real bot challenge', () => {
    expect(loadConfig(production).providers).toMatchObject({
      whatsapp: 'off',
      video: 'off',
      botChallenge: 'turnstile',
    });
  });

  it('refuses a simulator in production and names the variable, never a value', () => {
    expect(() => loadConfig({ ...production, WHATSAPP_PROVIDER: 'local' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...production, WHATSAPP_PROVIDER: 'local' })).toThrow(
      /WHATSAPP_PROVIDER/,
    );
    expect(() => loadConfig({ ...production, BOT_CHALLENGE: 'local' })).toThrow(/BOT_CHALLENGE/);
  });

  it('lets production run the simulators for a demo or staging when the flag says so', () => {
    const config = loadConfig({
      ...production,
      WHATSAPP_PROVIDER: 'local',
      VIDEO_PROVIDER: 'local',
      BOT_CHALLENGE: 'local',
      ALLOW_LOCAL_PROVIDERS: 'true',
      LOCAL_PROVIDERS_CONSOLE: 'true',
    });

    expect(config.providers).toMatchObject({
      whatsapp: 'local',
      allowLocalProviders: true,
      localProvidersConsole: true,
    });
  });

  it('requires the app secret of the real WhatsApp provider, because its webhook is signed', () => {
    const meta = { ...production, WHATSAPP_PROVIDER: 'meta' };

    expect(() => loadConfig(meta)).toThrow(/WHATSAPP_APP_SECRET/);
    expect(
      loadConfig({ ...meta, WHATSAPP_APP_SECRET: 'placeholder-app-secret-0123456789' }).providers
        .whatsappAppSecret,
    ).toBe('placeholder-app-secret-0123456789');
  });

  it('requires the pepper of the address hashes in production, and names it without printing it', () => {
    expect(() => loadConfig({ ...production, ADDRESS_HASH_PEPPER: undefined })).toThrow(
      /ADDRESS_HASH_PEPPER/,
    );
    expect(loadConfig(production).providers.addressHashPepper).toBe(
      'placeholder-pepper-0123456789-abcdefghij',
    );
    expect(loadConfig(base).providers.addressHashPepper).toBeUndefined();
    expect(() => loadConfig({ ...base, ADDRESS_HASH_PEPPER: 'short-pepper' })).toThrow(
      /ADDRESS_HASH_PEPPER/,
    );
  });

  it('reads the hosts a manual video link may point at', () => {
    const config = loadConfig({
      ...base,
      VIDEO_ALLOWED_DOMAINS: 'meet.google.com, Zoom.us ,meet.jit.si',
    });

    expect(config.providers.videoAllowedDomains).toEqual([
      'meet.google.com',
      'zoom.us',
      'meet.jit.si',
    ]);
  });

  it('reads the address of the video server of the local provider, and leaves it unset otherwise', () => {
    expect(loadConfig(base).providers.videoLocalBaseUrl).toBeUndefined();
    expect(
      loadConfig({ ...base, VIDEO_LOCAL_BASE_URL: 'https://jitsi.clinic.example/' }).providers
        .videoLocalBaseUrl,
    ).toBe('https://jitsi.clinic.example/');
  });

  it.each([
    ['http://jitsi.clinic.example', 'not https'],
    ['jitsi.clinic.example', 'not an address'],
    ['https://user:secret@jitsi.clinic.example', 'carries credentials'],
    ['https://jitsi.clinic.example/?room=1', 'carries a query'],
  ])('rejects the video server address %s (%s)', (value) => {
    expect(() => loadConfig({ ...base, VIDEO_LOCAL_BASE_URL: value })).toThrow(
      /VIDEO_LOCAL_BASE_URL/,
    );
  });

  it('rejects values that are not one of the providers, a malformed host and a short secret', () => {
    expect(() => loadConfig({ ...base, WHATSAPP_PROVIDER: 'twilio' })).toThrow(/WHATSAPP_PROVIDER/);
    expect(() => loadConfig({ ...base, VIDEO_PROVIDER: 'zoom' })).toThrow(/VIDEO_PROVIDER/);
    expect(() => loadConfig({ ...base, VIDEO_ALLOWED_DOMAINS: 'https://meet.example' })).toThrow(
      /VIDEO_ALLOWED_DOMAINS/,
    );
    expect(() => loadConfig({ ...base, WHATSAPP_APP_SECRET: 'short' })).toThrow(
      /WHATSAPP_APP_SECRET/,
    );
  });

  it('never prints the secret in the startup error', () => {
    let message = '';
    try {
      loadConfig({ ...base, WHATSAPP_APP_SECRET: 'tiny-secret' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain('WHATSAPP_APP_SECRET');
    expect(message).not.toContain('tiny-secret');
  });

  it('is written down for whoever deploys: every variable appears in the developer guide', () => {
    const guide = readFileSync(new URL('../../../../docs/dev-setup.md', import.meta.url), 'utf8');

    expect(PROVIDER_ENV_VARIABLES.length).toBeGreaterThanOrEqual(7);
    for (const name of PROVIDER_ENV_VARIABLES) expect(guide, name).toContain(name);
  });
});
