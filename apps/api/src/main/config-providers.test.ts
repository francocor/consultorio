import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { generateReleaserKeys } from '../modules/tenancy/archive/archive-crypto.js';

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
      afip: 'local',
      erx: 'local',
      payments: 'local',
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
      afip: 'off',
      erx: 'off',
      payments: 'off',
    });
  });

  it('refuses a simulator in production and names the variable, never a value', () => {
    expect(() => loadConfig({ ...production, WHATSAPP_PROVIDER: 'local' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...production, WHATSAPP_PROVIDER: 'local' })).toThrow(
      /WHATSAPP_PROVIDER/,
    );
    expect(() => loadConfig({ ...production, BOT_CHALLENGE: 'local' })).toThrow(/BOT_CHALLENGE/);
    expect(() => loadConfig({ ...production, AFIP_PROVIDER: 'local' })).toThrow(/AFIP_PROVIDER/);
    expect(() => loadConfig({ ...production, ERX_PROVIDER: 'local' })).toThrow(/ERX_PROVIDER/);
    expect(() => loadConfig({ ...production, PAYMENTS_PROVIDER: 'local' })).toThrow(
      /PAYMENTS_PROVIDER/,
    );
  });

  it('runs the payments simulator in development, selects none by name, and refuses an unknown provider', () => {
    expect(loadConfig({ ...base, PAYMENTS_PROVIDER: 'off' }).providers.payments).toBe('off');
    expect(loadConfig({ ...base, PAYMENTS_PROVIDER: 'local' }).providers.payments).toBe('local');
    expect(loadConfig({ ...production, PAYMENTS_PROVIDER: 'off' }).providers.payments).toBe('off');
    // A real provider key is added by task 6.50, with its adapter: until then only these two exist.
    expect(() => loadConfig({ ...base, PAYMENTS_PROVIDER: 'mercadopago' })).toThrow(
      /PAYMENTS_PROVIDER/,
    );
  });

  it('keeps the secret that signs the payments webhook, and never prints it', () => {
    const secret = 'placeholder-mp-webhook-secret-0123';

    expect(loadConfig({ ...base, MP_WEBHOOK_SECRET: secret }).providers.mpWebhookSecret).toBe(
      secret,
    );
    expect(loadConfig(base).providers.mpWebhookSecret).toBeUndefined();
    let message = '';
    try {
      loadConfig({ ...base, MP_WEBHOOK_SECRET: 'tiny' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('MP_WEBHOOK_SECRET');
    expect(message).not.toContain('tiny');
  });

  it('reads the public address the checkout and the webhook are reached on, and leaves it unset otherwise', () => {
    expect(loadConfig(base).providers.mpPublicBaseUrl).toBeUndefined();
    expect(
      loadConfig({ ...base, MP_PUBLIC_BASE_URL: 'https://platform.consultorio.example' }).providers
        .mpPublicBaseUrl,
    ).toBe('https://platform.consultorio.example');
    // A development tunnel or a local port may be plain http; production may not.
    expect(
      loadConfig({ ...base, MP_PUBLIC_BASE_URL: 'http://localhost:4010' }).providers
        .mpPublicBaseUrl,
    ).toBe('http://localhost:4010');
  });

  it.each([
    ['platform.consultorio.example', 'not an address'],
    ['ftp://platform.consultorio.example', 'not http or https'],
    ['https://user:secret@platform.consultorio.example', 'carries credentials'],
    ['https://platform.consultorio.example/?a=1', 'carries a query'],
    ['https://platform.consultorio.example/#frag', 'carries a fragment'],
  ])('rejects the payments public address %s (%s)', (value) => {
    expect(() => loadConfig({ ...base, MP_PUBLIC_BASE_URL: value })).toThrow(/MP_PUBLIC_BASE_URL/);
  });

  it('wants https for the payments public address in production, since Mercado Pago will not call plain http', () => {
    expect(() =>
      loadConfig({ ...production, MP_PUBLIC_BASE_URL: 'http://platform.example' }),
    ).toThrow(/MP_PUBLIC_BASE_URL/);
    expect(
      loadConfig({ ...production, MP_PUBLIC_BASE_URL: 'https://platform.example' }).providers
        .mpPublicBaseUrl,
    ).toBe('https://platform.example');
  });

  it('runs the prescription simulator in development, selects none by name, and refuses an unknown provider', () => {
    expect(loadConfig({ ...base, ERX_PROVIDER: 'off' }).providers.erx).toBe('off');
    expect(loadConfig({ ...base, ERX_PROVIDER: 'local' }).providers.erx).toBe('local');
    expect(loadConfig({ ...production, ERX_PROVIDER: 'off' }).providers.erx).toBe('off');
    // A real provider key is added by task 5.53, with its adapter: until then only these two exist.
    expect(() => loadConfig({ ...base, ERX_PROVIDER: 'recetario' })).toThrow(/ERX_PROVIDER/);
  });

  it('keeps the secret that signs the provider webhook, and never prints it', () => {
    const secret = 'placeholder-erx-webhook-secret-0123';

    expect(loadConfig({ ...base, ERX_WEBHOOK_SECRET: secret }).providers.erxWebhookSecret).toBe(
      secret,
    );
    expect(loadConfig(base).providers.erxWebhookSecret).toBeUndefined();
    let message = '';
    try {
      loadConfig({ ...base, ERX_WEBHOOK_SECRET: 'tiny' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('ERX_WEBHOOK_SECRET');
    expect(message).not.toContain('tiny');
  });

  it('runs the AFIP simulator in development and selects the real provider or none by name', () => {
    expect(loadConfig({ ...base, AFIP_PROVIDER: 'afip' }).providers.afip).toBe('afip');
    expect(loadConfig({ ...base, AFIP_PROVIDER: 'off' }).providers.afip).toBe('off');
    expect(loadConfig({ ...production, AFIP_PROVIDER: 'afip' }).providers.afip).toBe('afip');
    expect(() => loadConfig({ ...base, AFIP_PROVIDER: 'wsfe' })).toThrow(/AFIP_PROVIDER/);
  });

  it('lets production run the simulators for a demo or staging when the flag says so', () => {
    const config = loadConfig({
      ...production,
      WHATSAPP_PROVIDER: 'local',
      VIDEO_PROVIDER: 'local',
      BOT_CHALLENGE: 'local',
      AFIP_PROVIDER: 'local',
      ERX_PROVIDER: 'local',
      PAYMENTS_PROVIDER: 'local',
      ALLOW_LOCAL_PROVIDERS: 'true',
      LOCAL_PROVIDERS_CONSOLE: 'true',
    });

    expect(config.providers).toMatchObject({
      whatsapp: 'local',
      afip: 'local',
      erx: 'local',
      payments: 'local',
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
    expect(PROVIDER_ENV_VARIABLES).toContain('AFIP_PROVIDER');
    expect(PROVIDER_ENV_VARIABLES).toContain('ERX_PROVIDER');
    expect(PROVIDER_ENV_VARIABLES).toContain('ERX_WEBHOOK_SECRET');
    expect(PROVIDER_ENV_VARIABLES).toContain('PAYMENTS_PROVIDER');
    expect(PROVIDER_ENV_VARIABLES).toContain('MP_WEBHOOK_SECRET');
    expect(PROVIDER_ENV_VARIABLES).toContain('MP_PUBLIC_BASE_URL');
    for (const name of PROVIDER_ENV_VARIABLES) expect(guide, name).toContain(name);
  });
});

describe('the retention archive settings', () => {
  const pair = generateReleaserKeys();
  const archive = {
    ...base,
    ARCHIVE_S3_BUCKET: 'consultorio-archive',
    ARCHIVE_S3_ENDPOINT: 'http://127.0.0.1:9000',
    ARCHIVE_S3_ACCESS_KEY_ID: 'archive-writer',
    ARCHIVE_S3_SECRET_ACCESS_KEY: 'placeholder-writer-secret',
    ARCHIVE_RELEASER_PUBLIC_KEY: pair.publicKey,
  };

  it('is absent when no bucket is named, and nothing is archived', () => {
    expect(loadConfig(base).providers.archive).toBeUndefined();
  });

  it('reads the bucket, the identity that writes, the retention and the key it seals to', () => {
    const { archive: found } = loadConfig(archive).providers;

    expect(found).toEqual({
      storage: {
        bucket: 'consultorio-archive',
        region: 'us-east-1',
        endpoint: 'http://127.0.0.1:9000',
        credentials: {
          accessKeyId: 'archive-writer',
          secretAccessKey: 'placeholder-writer-secret',
        },
      },
      retentionDays: 3650,
      afterDays: 30,
      releaserPublicKey: pair.publicKey,
    });
    expect(found).not.toHaveProperty('releaserKek');
  });

  it('keeps ten years and thirty days unless told otherwise, and accepts other figures', () => {
    const { archive: found } = loadConfig({
      ...archive,
      ARCHIVE_RETENTION_DAYS: '7300',
      ARCHIVE_AFTER_DAYS: '0',
    }).providers;

    expect(found).toMatchObject({ retentionDays: 7300, afterDays: 0 });
    expect(() => loadConfig({ ...archive, ARCHIVE_RETENTION_DAYS: '0' })).toThrow(
      /ARCHIVE_RETENTION_DAYS/,
    );
    expect(() => loadConfig({ ...archive, ARCHIVE_AFTER_DAYS: '-1' })).toThrow(
      /ARCHIVE_AFTER_DAYS/,
    );
  });

  it('gives the releaser only its private key: the public one is derived from it', () => {
    const withoutPublic: Record<string, string> = { ...archive };
    delete withoutPublic['ARCHIVE_RELEASER_PUBLIC_KEY'];

    const { archive: found } = loadConfig({
      ...withoutPublic,
      ARCHIVE_RELEASER_KEK: pair.kek,
    }).providers;

    expect(found).toMatchObject({ releaserPublicKey: pair.publicKey, releaserKek: pair.kek });
  });

  it('refuses a private key that is not the one of the public key it is given with', () => {
    const stranger = generateReleaserKeys();

    expect(() => loadConfig({ ...archive, ARCHIVE_RELEASER_KEK: stranger.kek })).toThrow(
      /ARCHIVE_RELEASER_PUBLIC_KEY/,
    );
  });

  it('refuses a half-configured archive and names the variable, never its value', () => {
    for (const missing of [
      'ARCHIVE_S3_ENDPOINT',
      'ARCHIVE_S3_ACCESS_KEY_ID',
      'ARCHIVE_S3_SECRET_ACCESS_KEY',
      'ARCHIVE_RELEASER_PUBLIC_KEY',
    ] as const) {
      const rest = Object.fromEntries(Object.entries(archive).filter(([name]) => name !== missing));
      expect(() => loadConfig(rest), missing).toThrow(new RegExp(missing));
    }
    expect(() => loadConfig({ ...base, ARCHIVE_RELEASER_PUBLIC_KEY: pair.publicKey })).toThrow(
      /ARCHIVE_S3_BUCKET/,
    );
    let message = '';
    try {
      loadConfig({ ...archive, ARCHIVE_RELEASER_PUBLIC_KEY: 'bm90IGEga2V5' });
    } catch (error) {
      message = error instanceof ConfigError ? error.message : '';
    }
    expect(message).toContain('ARCHIVE_RELEASER_PUBLIC_KEY');
    expect(message).not.toContain('bm90IGEga2V5');
  });
});
