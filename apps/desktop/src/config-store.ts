import { randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { InstallSecrets } from './secrets.js';

/** What protects the secrets. In the app it is Electron `safeStorage` (DPAPI, tied to the Windows account). */
export interface Cipher {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface InstallSettings {
  /** Start with Windows. Off unless the owner ticks it in the tray. */
  autoStart: boolean;
  /** The "it keeps running in the tray" notice was shown. */
  trayHintShown: boolean;
  /** `YYYY-MM-DD` (local date) of the last automatic backup. */
  lastDailyBackup: string | null;
  /** When the person was last reminded to copy the backups off this PC (ISO); starts at the setup. */
  lastCopyReminder: string | null;
  /** When the last backup that passed its check was made (ISO). */
  lastGoodBackup: string | null;
  /** The notice that the backups sit in a folder synced to the internet was shown. */
  cloudNoticeShown: boolean;
}

/** How far the first-run work got. A crash before `ready` is repaired by starting that part again. */
export type DatabaseState = 'new' | 'ready';

export interface InstallConfig {
  installId: string;
  /** The port of the local server. `PUBLIC_URL` is built from it, so it never changes. */
  port: number;
  /** `SINGLE_TENANT_SLUG`. Chosen on the setup screen. */
  slug: string | null;
  databaseState: DatabaseState;
  provisioned: boolean;
  /** The owner confirmed having saved the recovery key; until then the key is kept to be shown again. */
  recoveryAcknowledged: boolean;
  settings: InstallSettings;
  secrets: InstallSecrets;
}

export type ConfigErrorCode = 'cipher_unavailable' | 'unreadable' | 'cannot_decrypt';

export class ConfigError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

const SecretsSchema = z.strictObject({
  pgSuperuserPassword: z.string().min(16),
  appOwnerPassword: z.string().min(16),
  appRwPassword: z.string().min(16),
  auditSealerPassword: z.string().min(16),
  kmsLocalKekBase64: z.string().min(40),
  addressHashPepper: z.string().min(32),
  storageUploadSecret: z.string().min(32),
  backupKeyBase64: z.string().min(40),
  backupKeyWrap: z.strictObject({
    salt: z.string().min(1),
    iv: z.string().min(1),
    tag: z.string().min(1),
    data: z.string().min(1),
  }),
  recoveryKeyHash: z.string().min(20),
  recoveryKey: z.string().min(20).nullable(),
});

const PublicSchema = z.strictObject({
  installId: z.string().min(1),
  port: z.number().int().min(1024).max(65535),
  slug: z.string().nullable(),
  databaseState: z.enum(['new', 'ready']),
  provisioned: z.boolean(),
  /** The owner confirmed having saved the recovery key. */
  recoveryAcknowledged: z.boolean(),
  settings: z.strictObject({
    autoStart: z.boolean(),
    trayHintShown: z.boolean(),
    lastDailyBackup: z.string().nullable(),
    lastCopyReminder: z.string().nullable(),
    lastGoodBackup: z.string().nullable(),
    cloudNoticeShown: z.boolean(),
  }),
});

const FileSchema = z.strictObject({
  version: z.literal(1),
  public: PublicSchema,
  /** The secrets as one JSON document, encrypted and in base64. */
  secrets: z.string().min(1),
});

/** A fresh configuration for the first run. */
export function newInstallConfig(port: number, secrets: InstallSecrets): InstallConfig {
  return {
    installId: randomUUID(),
    port,
    slug: null,
    databaseState: 'new',
    provisioned: false,
    recoveryAcknowledged: false,
    settings: {
      autoStart: false,
      trayHintShown: false,
      lastDailyBackup: null,
      lastCopyReminder: null,
      lastGoodBackup: null,
      cloudNoticeShown: false,
    },
    secrets,
  };
}

/**
 * `config.json`: the settings in the clear and every secret in one encrypted block. The file is written
 * to a temporary name and renamed over the old one, and the old one is kept as `config.json.bak`: it holds
 * the key of the clinical data, so an interrupted write must never leave the install without it.
 */
export class ConfigStore {
  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
  ) {}

  exists(): boolean {
    return existsSync(this.file);
  }

  /** The store of the previous good copy (`config.json.bak`). */
  previous(): ConfigStore {
    return new ConfigStore(`${this.file}.bak`, this.cipher);
  }

  read(): InstallConfig {
    if (!this.cipher.isAvailable()) {
      throw new ConfigError(
        'cipher_unavailable',
        'The Windows account cannot encrypt secrets right now.',
      );
    }
    let parsed;
    try {
      parsed = FileSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      throw new ConfigError('unreadable', 'config.json cannot be read.');
    }
    let secrets;
    try {
      const plain = this.cipher.decrypt(Buffer.from(parsed.secrets, 'base64'));
      secrets = SecretsSchema.parse(JSON.parse(plain));
    } catch {
      throw new ConfigError(
        'cannot_decrypt',
        'The secrets cannot be decrypted with this Windows account.',
      );
    }
    return { ...parsed.public, secrets };
  }

  write(config: InstallConfig): void {
    if (!this.cipher.isAvailable()) {
      throw new ConfigError(
        'cipher_unavailable',
        'The Windows account cannot encrypt secrets right now.',
      );
    }
    const { secrets, ...publicPart } = config;
    const encrypted = this.cipher.encrypt(JSON.stringify(secrets)).toString('base64');
    const body = `${JSON.stringify({ version: 1, public: publicPart, secrets: encrypted }, null, 2)}\n`;
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeDurably(temporary, body);
    if (existsSync(this.file)) {
      copyFileSync(this.file, `${this.file}.bak`);
      syncFile(`${this.file}.bak`);
    }
    renameWithRetry(temporary, this.file);
  }

  /** Reads, lets `change` edit the configuration, writes it back and returns it. */
  update(change: (config: InstallConfig) => void): InstallConfig {
    const config = this.read();
    change(config);
    this.write(config);
    return config;
  }
}

/** Forces a file that was just written to the disk, so a rename cannot reach it before the bytes do. */
function syncFile(path: string): void {
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Writes a new file and forces it to the disk before returning. */
function writeDurably(path: string, body: string): void {
  const fd = openSync(path, 'w', 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Windows refuses to rename over a file another process (an antivirus, an indexer) has open for a moment. */
function renameWithRetry(from: string, to: string, attempts = 8): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= attempts || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        rmSync(from, { force: true });
        throw error;
      }
      const until = Date.now() + 25 * attempt;
      while (Date.now() < until) {
        // Waits a few milliseconds without leaving the call: the write is a few times in the life of an install.
      }
    }
  }
}
