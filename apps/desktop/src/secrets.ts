import { randomBytes } from 'node:crypto';

import { hashRecoveryKey, wrapBackupKey, type KeyWrap } from './backup-crypto.js';
import { generateRecoveryKey } from './recovery-key.js';

export { normalizeRecoveryKey } from './recovery-key.js';

/**
 * Everything random an install needs. Generated once, on the first run, and stored encrypted by the
 * Windows account (`config-store.ts`). Losing `kmsLocalKekBase64` makes the clinical data unreadable.
 */
export interface InstallSecrets {
  /** The superuser `postgres` of the cluster. Only the shell uses it. */
  pgSuperuserPassword: string;
  appOwnerPassword: string;
  appRwPassword: string;
  auditSealerPassword: string;
  /** `KMS_LOCAL_KEK_BASE64`: 32 random bytes. */
  kmsLocalKekBase64: string;
  /** `ADDRESS_HASH_PEPPER`: at least 32 characters. */
  addressHashPepper: string;
  /** `STORAGE_UPLOAD_SECRET`: at least 32 characters. */
  storageUploadSecret: string;
  /** Encrypts and authenticates every backup of this install (see `backup-crypto.ts`). */
  backupKeyBase64: string;
  /** The backup key, wrapped by the recovery key: it goes in the header of every backup. */
  backupKeyWrap: KeyWrap;
  /** What the owner types is checked against this; the key itself is not kept past the first run. */
  recoveryKeyHash: string;
  /**
   * Always `null` now: the recovery key is never written to this PC. It exists in memory from the moment the
   * setup makes it until the owner confirms having saved it, and is shown once, in the answer to the setup. Only
   * its hash stays. The field is kept so a configuration written by an earlier build still reads; that build's
   * key, if it was never confirmed, is moved to memory at the next start and the field is emptied.
   */
  recoveryKey: string | null;
}

export type RandomBytes = (size: number) => Buffer;

/** URL- and SQL-safe text: letters, digits, `-` and `_`. */
const token = (random: RandomBytes, bytes: number) => random(bytes).toString('base64url');

/** What a new recovery key changes in the configuration: the wrap of the backup key and the hash that checks it. */
export interface FreshRecoveryKey {
  /** For the owner's eyes, once. Never stored. */
  recoveryKey: string;
  backupKeyWrap: KeyWrap;
  recoveryKeyHash: string;
}

/** A new recovery key for the backup key `backupKeyBase64`. */
export function newRecoveryKey(
  backupKeyBase64: string,
  random: RandomBytes = randomBytes,
): FreshRecoveryKey {
  const recoveryKey = generateRecoveryKey(random);
  return {
    recoveryKey,
    backupKeyWrap: wrapBackupKey(Buffer.from(backupKeyBase64, 'base64'), recoveryKey),
    recoveryKeyHash: hashRecoveryKey(recoveryKey),
  };
}

/**
 * The secrets of a new install. The recovery key that goes with them is not known to anybody: the setup makes
 * the one the owner sees (`newRecoveryKey`), so nothing that is shown was ever written down by the program.
 */
export function generateSecrets(random: RandomBytes = randomBytes): InstallSecrets {
  const recoveryKey = generateRecoveryKey(random);
  const backupKey = random(32);
  return {
    pgSuperuserPassword: token(random, 32),
    appOwnerPassword: token(random, 32),
    appRwPassword: token(random, 32),
    auditSealerPassword: token(random, 32),
    kmsLocalKekBase64: random(32).toString('base64'),
    addressHashPepper: token(random, 36),
    storageUploadSecret: token(random, 36),
    backupKeyBase64: backupKey.toString('base64'),
    backupKeyWrap: wrapBackupKey(backupKey, recoveryKey),
    recoveryKeyHash: hashRecoveryKey(recoveryKey),
    recoveryKey: null,
  };
}
