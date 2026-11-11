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

  it('sets a damaged file aside under a name of its own and never copies it over the previous good one', () => {
    const store = new ConfigStore(file, fakeCipher());
    store.write(newInstallConfig(47800, generateSecrets()));
    store.write(newInstallConfig(47800, generateSecrets()));
    const good = readFileSync(`${file}.bak`, 'utf8');
    writeFileSync(file, '{ not a configuration');

    const moved = store.quarantine('7');

    expect(moved).toBe(`${file}.corrupt-7`);
    expect(readFileSync(`${file}.corrupt-7`, 'utf8')).toBe('{ not a configuration');
    expect(store.exists()).toBe(false);
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe(good);
    // And there is nothing to set aside when there is no file.
    expect(store.quarantine('8')).toBeNull();
  });

  it('does not make the previous copy out of a file that cannot be read', () => {
    const store = new ConfigStore(file, fakeCipher());
    store.write(newInstallConfig(47800, generateSecrets()));
    store.write(newInstallConfig(47800, generateSecrets()));
    const good = readFileSync(`${file}.bak`, 'utf8');
    writeFileSync(file, '{ damaged');

    store.write(newInstallConfig(47800, generateSecrets()));

    expect(readFileSync(`${file}.bak`, 'utf8')).toBe(good);
  });

  describe('a file written by another version', () => {
    /** Rewrites the file as an earlier build wrote it: fields that did not exist yet are not there. */
    function asAnEarlierBuild(
      change: (file: Record<string, unknown>, secrets: Record<string, unknown>) => void,
    ) {
      const cipher = fakeCipher();
      const raw = JSON.parse(readFileSync(file, 'utf8')) as {
        public: Record<string, unknown>;
        secrets: string;
      };
      const secrets = JSON.parse(cipher.decrypt(Buffer.from(raw.secrets, 'base64'))) as Record<
        string,
        unknown
      >;
      change(raw.public, secrets);
      raw.secrets = cipher.encrypt(JSON.stringify(secrets)).toString('base64');
      writeFileSync(file, JSON.stringify(raw));
    }

    it('fills in the settings and fields that did not exist yet, so a new field never makes the install unreadable', () => {
      const store = new ConfigStore(file, fakeCipher());
      store.write(newInstallConfig(47800, generateSecrets()));
      asAnEarlierBuild((publicPart, secrets) => {
        const settings = publicPart['settings'] as Record<string, unknown>;
        delete settings['cloudNoticeShown'];
        delete settings['lastGoodBackup'];
        delete settings['lastCopyReminder'];
        delete publicPart['recoveryAcknowledged'];
        delete secrets['recoveryKey'];
      });

      const read = store.read();

      expect(read.settings).toMatchObject({
        cloudNoticeShown: false,
        lastGoodBackup: null,
        lastCopyReminder: null,
        autoStart: false,
      });
      expect(read.recoveryAcknowledged).toBe(false);
      expect(read.secrets.recoveryKey).toBeNull();
    });

    it('reads a file with fields it does not know, which a newer build added', () => {
      const store = new ConfigStore(file, fakeCipher());
      store.write(newInstallConfig(47800, generateSecrets()));
      asAnEarlierBuild((publicPart, secrets) => {
        publicPart['somethingNew'] = true;
        (publicPart['settings'] as Record<string, unknown>)['alsoNew'] = 1;
        secrets['aNewSecret'] = 'x';
      });

      expect(() => store.read()).not.toThrow();
    });

    it('still refuses what is not a configuration, and a file of a version it cannot know', () => {
      const store = new ConfigStore(file, fakeCipher());
      store.write(newInstallConfig(47800, generateSecrets()));
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

      writeFileSync(file, JSON.stringify({ ...raw, version: 2 }));
      expect(() => store.read()).toThrow(ConfigError);

      writeFileSync(file, JSON.stringify({ ...raw, public: { port: 'not a number' } }));
      expect(() => store.read()).toThrow(ConfigError);
    });

    it('writes the version of the format in the file, to know what to migrate when it changes', () => {
      new ConfigStore(file, fakeCipher()).write(newInstallConfig(47800, generateSecrets()));

      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1 });
    });
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
});
