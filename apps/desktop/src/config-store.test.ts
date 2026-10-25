import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, ConfigStore, newInstallConfig, type Cipher } from './config-store.js';
import { generateSecrets } from './secrets.js';

/** Stands in for Electron's safeStorage: reversible, and visibly not plain text. */
function fakeCipher(available = true): Cipher {
  return {
    isAvailable: () => available,
    encrypt: (plain) => Buffer.from(Buffer.from(plain, 'utf8').reverse().toString('base64')),
    decrypt: (data) =>
      Buffer.from(Buffer.from(data.toString(), 'base64').reverse()).toString('utf8'),
  };
}

let folder: string;
let file: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'consulvia-config-'));
  file = join(folder, 'data', 'config.json');
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('config.json', () => {
  it('stores the settings in the clear and every secret encrypted', () => {
    const store = new ConfigStore(file, fakeCipher());
    const config = newInstallConfig(47800, generateSecrets());

    store.write(config);

    const text = readFileSync(file, 'utf8');
    expect(JSON.parse(text)).toMatchObject({
      version: 1,
      public: { port: 47800, provisioned: false },
    });
    for (const secret of [
      config.secrets.kmsLocalKekBase64,
      config.secrets.appRwPassword,
      config.secrets.backupKeyBase64,
      config.secrets.storageUploadSecret,
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('reads back what was written', () => {
    const store = new ConfigStore(file, fakeCipher());
    const config = newInstallConfig(47801, generateSecrets());
    config.slug = 'consultorio';
    store.write(config);

    expect(store.read()).toEqual(config);
  });

  it('changes one setting at a time and keeps the rest', () => {
    const store = new ConfigStore(file, fakeCipher());
    const config = newInstallConfig(47800, generateSecrets());
    store.write(config);

    const updated = store.update((current) => {
      current.settings.autoStart = true;
      current.provisioned = true;
    });

    expect(updated.settings.autoStart).toBe(true);
    expect(store.read()).toEqual({
      ...config,
      provisioned: true,
      settings: { ...config.settings, autoStart: true },
    });
  });

  it('keeps the previous file as config.json.bak on every write, and leaves no temporary file', () => {
    const store = new ConfigStore(file, fakeCipher());
    const first = newInstallConfig(47800, generateSecrets());
    store.write(first);
    store.update((current) => {
      current.port = 47811;
    });

    expect(store.previous().read()).toEqual(first);
    expect(store.read().port).toBe(47811);
    expect(() => readFileSync(`${file}.tmp`)).toThrow();
  });

  it('refuses to write or read when the Windows account cannot encrypt, and never writes plain text', () => {
    const store = new ConfigStore(file, fakeCipher(false));

    expect(() => {
      store.write(newInstallConfig(47800, generateSecrets()));
    }).toThrow(ConfigError);
    expect(store.exists()).toBe(false);
  });

  it('says so when the secrets cannot be decrypted (another Windows account)', () => {
    new ConfigStore(file, fakeCipher()).write(newInstallConfig(47800, generateSecrets()));
    const other: Cipher = {
      isAvailable: () => true,
      encrypt: (plain) => Buffer.from(plain),
      decrypt: () => {
        throw new Error(
          'Error while decrypting the ciphertext provided to safeStorage.decryptString',
        );
      },
    };

    expect(() => new ConfigStore(file, other).read()).toThrow(
      expect.objectContaining({ code: 'cannot_decrypt' }),
    );
  });

  it('says so when the file is damaged, so the caller can try the previous copy', () => {
    const store = new ConfigStore(file, fakeCipher());
    store.write(newInstallConfig(47800, generateSecrets()));
    writeFileSync(file, '{ not json');

    expect(() => store.read()).toThrow(expect.objectContaining({ code: 'unreadable' }));
  });

  it('refuses a file that has a field it does not know', () => {
    const store = new ConfigStore(file, fakeCipher());
    store.write(newInstallConfig(47800, generateSecrets()));
    const document = JSON.parse(readFileSync(file, 'utf8')) as { public: Record<string, unknown> };
    document.public['surprise'] = true;
    writeFileSync(file, JSON.stringify(document));

    expect(() => store.read()).toThrow(expect.objectContaining({ code: 'unreadable' }));
  });
});
