import { describe, expect, it } from 'vitest';

import { omit } from '../testing/omit.js';

import { ConfigError, loadConfig } from './config.js';

const DATABASE_URL = 'postgres://app_rw:placeholder@127.0.0.1:54329/consulvia';
const LOCAL_KEK = Buffer.alloc(32, 7).toString('base64');
const PEPPER = 'placeholder-pepper-0123456789-abcdefghij';

const FILES_DIR = process.platform === 'win32' ? 'C:\\Consulvia\\files' : '/var/consulvia/files';
const UPLOAD_SECRET = 'placeholder-upload-secret-0123456789-abcdef';
const OUTBOX = process.platform === 'win32' ? 'C:\\Consulvia\\outbox' : '/var/consulvia/outbox';

/** What the desktop shell hands the API, but for the folder of the files. */
const desktopWithoutFiles = {
  NODE_ENV: 'production',
  DEPLOYMENT_PROFILE: 'desktop',
  DEPLOYMENT_MODE: 'single',
  SINGLE_TENANT_SLUG: 'clinica-norte',
  PUBLIC_URL: 'http://127.0.0.1:41234',
  PORT: '41235',
  DATABASE_URL,
  KMS_PROVIDER: 'local',
  KMS_LOCAL_KEK_BASE64: LOCAL_KEK,
  ADDRESS_HASH_PEPPER: PEPPER,
};

/** What the desktop shell hands the API: nothing else is needed to boot. */
const desktop = {
  ...desktopWithoutFiles,
  STORAGE_DIR: FILES_DIR,
  STORAGE_UPLOAD_SECRET: UPLOAD_SECRET,
  OUTBOX_DIR: OUTBOX,
};

const withoutOutbox = omit(desktop, 'OUTBOX_DIR');

/** A hosted single-organization production deployment: every row of the profile table is refused. */
const hostedSingle = {
  NODE_ENV: 'production',
  DEPLOYMENT_MODE: 'single',
  SINGLE_TENANT_SLUG: 'clinica-norte',
  PUBLIC_URL: 'https://agenda.clinica.example',
  DATABASE_URL,
  KMS_PROVIDER: 'aws',
  AWS_REGION: 'sa-east-1',
  AWS_KMS_KEY_ID: 'alias/consultorio',
  ADDRESS_HASH_PEPPER: PEPPER,
  SMTP_HOST: 'email-smtp.sa-east-1.amazonaws.com',
  SMTP_SECURITY: 'starttls',
};

describe('the hosted profile (the default)', () => {
  it('is hosted when DEPLOYMENT_PROFILE is not set', () => {
    expect(loadConfig(hostedSingle).profile).toBe('hosted');
    expect(loadConfig({ ...hostedSingle, DEPLOYMENT_PROFILE: 'hosted' }).profile).toBe('hosted');
  });

  it('refuses a profile it does not know', () => {
    expect(() => loadConfig({ ...hostedSingle, DEPLOYMENT_PROFILE: 'laptop' })).toThrow(
      /DEPLOYMENT_PROFILE/,
    );
  });

  it('still binds every interface and secures the cookie and trusts one proxy in production', () => {
    expect(loadConfig(hostedSingle)).toMatchObject({
      host: '0.0.0.0',
      cookieSecure: true,
      trustProxy: 1,
    });
  });

  it.each([
    ['the local key-encryption key', { KMS_PROVIDER: 'local', KMS_LOCAL_KEK_BASE64: LOCAL_KEK }],
    ['an http public address', { PUBLIC_URL: 'http://localhost:3000' }],
    ['an insecure cookie', { COOKIE_SECURE: 'false' }],
    ['a missing mail server', { SMTP_HOST: undefined }],
    ['a mail server without transport security', { SMTP_SECURITY: 'none' }],
    ['a missing address pepper', { ADDRESS_HASH_PEPPER: undefined }],
    [
      'static storage keys',
      { S3_BUCKET: 'files-bucket', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' },
    ],
    ['a WhatsApp simulator', { WHATSAPP_PROVIDER: 'local' }],
    ['a payments simulator', { PAYMENTS_PROVIDER: 'local' }],
    ['the local bot challenge', { BOT_CHALLENGE: 'local' }],
  ] as const)('keeps refusing %s in a hosted production', (_name, change) => {
    // An undefined value is a variable that is not set.
    expect(() => loadConfig({ ...hostedSingle, ...change })).toThrow(ConfigError);
  });
});

describe('the desktop profile', () => {
  it('boots with the minimal environment the shell provides', () => {
    const config = loadConfig(desktop);

    expect(config).toMatchObject({
      profile: 'desktop',
      nodeEnv: 'production',
      deploymentMode: 'single',
      singleTenantSlug: 'clinica-norte',
      publicUrl: 'http://127.0.0.1:41234',
      host: '127.0.0.1',
      port: 41235,
      cookieSecure: false,
      trustProxy: false,
      kms: { provider: 'local' },
    });
    expect(config.mail).toBeUndefined();
    expect(config.providers).toMatchObject({
      whatsapp: 'off',
      video: 'off',
      afip: 'off',
      erx: 'off',
      payments: 'off',
      botChallenge: 'local',
    });
    expect(config.providers.archive).toBeUndefined();
  });

  it('accepts http and https loopback addresses with a port, and nothing else', () => {
    for (const url of [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'https://localhost:8443',
    ]) {
      expect(loadConfig({ ...desktop, PUBLIC_URL: url }).publicUrl).toBe(url);
    }
    for (const url of [
      'http://localhost',
      'http://127.0.0.1',
      'http://192.168.1.20:3000',
      'http://agenda.clinica.example:3000',
      'https://agenda.clinica.example',
      'http://localhost.evil.example:3000',
      'http://127.0.0.1.evil.example:3000',
      'http://user:pass@localhost:3000',
      'http://[::1]:3000',
    ]) {
      expect(() => loadConfig({ ...desktop, PUBLIC_URL: url }), url).toThrow(/PUBLIC_URL/);
    }
  });

  it('needs single mode and production', () => {
    expect(() =>
      loadConfig({
        ...omit(omit(desktop, 'SINGLE_TENANT_SLUG'), 'PUBLIC_URL'),
        DEPLOYMENT_MODE: 'multi',
        BASE_DOMAIN: 'consultorio.test',
        PLATFORM_HOST: 'platform.consultorio.test',
      }),
    ).toThrow(/DEPLOYMENT_MODE.*single/);
    expect(() => loadConfig({ ...desktop, NODE_ENV: 'development' })).toThrow(
      /NODE_ENV.*production/,
    );
    expect(() => loadConfig({ ...desktop, NODE_ENV: 'test' })).toThrow(/NODE_ENV/);
  });

  it('listens on the loopback only', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(loadConfig({ ...desktop, HOST: host }).host).toBe(host);
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.20', 'agenda.clinica.example']) {
      expect(() => loadConfig({ ...desktop, HOST: host }), host).toThrow(/HOST/);
    }
  });

  it('keeps the cookie plain and trusts no proxy', () => {
    expect(() => loadConfig({ ...desktop, COOKIE_SECURE: 'true' })).toThrow(/COOKIE_SECURE/);
    expect(loadConfig({ ...desktop, COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
    expect(() => loadConfig({ ...desktop, TRUST_PROXY: '1' })).toThrow(/TRUST_PROXY/);
    expect(loadConfig({ ...desktop, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
  });

  it('reads the secret of the run that the local server of the shell proves itself with', () => {
    const secret = 'a-per-run-secret-0123456789-abcdefghijklmnop';

    expect(loadConfig({ ...desktop, DESKTOP_PROXY_SECRET: secret }).desktopProxySecret).toBe(
      secret,
    );
    expect(loadConfig(desktop).desktopProxySecret).toBeUndefined();
    // The worker and the commands run without it; only the API refuses to start (see main.ts).
    expect(() => loadConfig({ ...desktop, DESKTOP_PROXY_SECRET: 'too-short' })).toThrow(
      /DESKTOP_PROXY_SECRET/,
    );
  });

  it('refuses the secret outside the desktop profile, where nothing would check it', () => {
    const secret = 'a-per-run-secret-0123456789-abcdefghijklmnop';

    expect(() => loadConfig({ ...hostedSingle, DESKTOP_PROXY_SECRET: secret })).toThrow(
      /DESKTOP_PROXY_SECRET/,
    );
  });

  it('still needs the address pepper', () => {
    expect(() => loadConfig(omit(desktop, 'ADDRESS_HASH_PEPPER'))).toThrow(/ADDRESS_HASH_PEPPER/);
  });

  it('still needs a key-encryption key', () => {
    expect(() => loadConfig(omit(desktop, 'KMS_LOCAL_KEK_BASE64'))).toThrow(/KMS_LOCAL_KEK_BASE64/);
  });

  it('keeps the transport security of a mail server when one is configured', () => {
    const smtp = { SMTP_HOST: 'smtp.clinica.example', SMTP_SECURITY: 'starttls' };

    expect(loadConfig({ ...withoutOutbox, ...smtp }).mail).toMatchObject({ host: smtp.SMTP_HOST });
    expect(() => loadConfig({ ...withoutOutbox, SMTP_HOST: 'smtp.clinica.example' })).toThrow(
      /SMTP_SECURITY/,
    );
  });

  it.each([
    'WHATSAPP_PROVIDER',
    'VIDEO_PROVIDER',
    'AFIP_PROVIDER',
    'ERX_PROVIDER',
    'PAYMENTS_PROVIDER',
  ])('refuses a simulator in %s instead of running it', (name) => {
    expect(() => loadConfig({ ...desktop, [name]: 'local' })).toThrow(new RegExp(name));
    expect(loadConfig({ ...desktop, [name]: 'off' })).toMatchObject({ profile: 'desktop' });
  });

  it('refuses a real provider: they need the internet and a contract', () => {
    expect(() =>
      loadConfig({ ...desktop, WHATSAPP_PROVIDER: 'meta', WHATSAPP_APP_SECRET: 'x'.repeat(20) }),
    ).toThrow(/WHATSAPP_PROVIDER/);
    expect(() => loadConfig({ ...desktop, VIDEO_PROVIDER: 'jaas' })).toThrow(/VIDEO_PROVIDER/);
    expect(() => loadConfig({ ...desktop, AFIP_PROVIDER: 'afip' })).toThrow(/AFIP_PROVIDER/);
    expect(() => loadConfig({ ...desktop, BOT_CHALLENGE: 'turnstile' })).toThrow(/BOT_CHALLENGE/);
  });

  it('refuses the simulator console', () => {
    expect(() => loadConfig({ ...desktop, LOCAL_PROVIDERS_CONSOLE: 'true' })).toThrow(
      /LOCAL_PROVIDERS_CONSOLE/,
    );
  });

  it('has no bucket and no archive', () => {
    expect(() => loadConfig({ ...desktop, S3_BUCKET: 'files-bucket' })).toThrow(/S3_BUCKET/);
    expect(() => loadConfig({ ...desktop, ARCHIVE_S3_BUCKET: 'archive-bucket' })).toThrow(
      /ARCHIVE_S3_BUCKET/,
    );
  });

  it('names every problem and no value', () => {
    let message = '';
    try {
      loadConfig({
        ...desktop,
        HOST: '0.0.0.0',
        PUBLIC_URL: 'http://secret-host.example:3000',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toMatch(/HOST/);
    expect(message).toMatch(/PUBLIC_URL/);
    expect(message).not.toContain('secret-host');
  });
});

describe('filesystem storage configuration', () => {
  const root = FILES_DIR;
  const secret = UPLOAD_SECRET;

  it('is how the desktop profile keeps its files, and the profile cannot start without it', () => {
    expect(() => loadConfig(desktopWithoutFiles)).toThrow(/STORAGE_DIR/);

    const config = loadConfig(desktop);

    expect(config.fsStorage).toEqual({ dir: root, uploadSecret: secret });
    expect(config.storage).toBeUndefined();
  });

  it('needs the upload secret with the folder, and the folder with the secret', () => {
    expect(() => loadConfig(omit(desktop, 'STORAGE_UPLOAD_SECRET'))).toThrow(
      /STORAGE_UPLOAD_SECRET/,
    );
    expect(() => loadConfig(omit(desktop, 'STORAGE_DIR'))).toThrow(/STORAGE_DIR/);
  });

  it('wants a secret of at least 32 characters and an absolute folder', () => {
    expect(() =>
      loadConfig({ ...desktop, STORAGE_DIR: root, STORAGE_UPLOAD_SECRET: 'too-short' }),
    ).toThrow(/STORAGE_UPLOAD_SECRET/);
    expect(() =>
      loadConfig({ ...desktop, STORAGE_DIR: 'files', STORAGE_UPLOAD_SECRET: secret }),
    ).toThrow(/STORAGE_DIR/);
    expect(() =>
      loadConfig({ ...desktop, STORAGE_DIR: '../files', STORAGE_UPLOAD_SECRET: secret }),
    ).toThrow(/STORAGE_DIR/);
  });

  it('is exclusive with a bucket', () => {
    expect(() =>
      loadConfig({
        ...omit(hostedSingle, 'SMTP_HOST'),
        NODE_ENV: 'development',
        S3_BUCKET: 'files-bucket',
        STORAGE_DIR: root,
        STORAGE_UPLOAD_SECRET: secret,
      }),
    ).toThrow(/STORAGE_DIR.*S3_BUCKET|S3_BUCKET.*STORAGE_DIR/);
  });

  it('is not how a hosted production keeps files: there it would skip the ClamAV rule', () => {
    expect(() =>
      loadConfig({ ...hostedSingle, STORAGE_DIR: root, STORAGE_UPLOAD_SECRET: secret }),
    ).toThrow(/STORAGE_DIR/);
  });

  it('is allowed outside production, for development', () => {
    const config = loadConfig({
      ...omit(hostedSingle, 'SMTP_HOST'),
      NODE_ENV: 'development',
      KMS_PROVIDER: 'local',
      KMS_LOCAL_KEK_BASE64: LOCAL_KEK,
      PUBLIC_URL: 'http://localhost:3000',
      STORAGE_DIR: root,
      STORAGE_UPLOAD_SECRET: secret,
    });

    expect(config.fsStorage).toEqual({ dir: root, uploadSecret: secret });
  });

  it('does not ask the desktop profile for ClamAV: the fake scanner is what runs', () => {
    expect(loadConfig(desktop).scanner).toBeUndefined();
  });
});

describe('outbox configuration', () => {
  const outbox = OUTBOX;
  const smtp = { SMTP_HOST: 'smtp.clinica.example', SMTP_SECURITY: 'starttls' };

  it('is where the desktop profile writes its mail when it has no mail server', () => {
    expect(() => loadConfig(withoutOutbox)).toThrow(/OUTBOX_DIR/);

    const config = loadConfig(desktop);

    expect(config.outbox).toEqual({ dir: outbox, from: 'Consulvia <no-responder@localhost>' });
    expect(config.mail).toBeUndefined();
  });

  it('takes the sender from MAIL_FROM', () => {
    const config = loadConfig({ ...desktop, MAIL_FROM: 'Clinica Norte <hola@clinica.example>' });

    expect(config.outbox?.from).toBe('Clinica Norte <hola@clinica.example>');
  });

  it('is not needed when the desktop profile has a mail server, and cannot be set beside one', () => {
    expect(loadConfig({ ...withoutOutbox, ...smtp }).outbox).toBeUndefined();
    expect(() => loadConfig({ ...desktop, ...smtp })).toThrow(/OUTBOX_DIR/);
  });

  it('wants an absolute folder', () => {
    expect(() => loadConfig({ ...desktop, OUTBOX_DIR: 'outbox' })).toThrow(/OUTBOX_DIR/);
  });

  it('does not replace the mail server of a hosted production', () => {
    expect(() => loadConfig({ ...omit(hostedSingle, 'SMTP_HOST'), OUTBOX_DIR: outbox })).toThrow(
      /SMTP_HOST/,
    );
  });
});
