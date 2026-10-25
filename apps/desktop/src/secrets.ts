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
   * The recovery key, shown to the owner once. It is removed from the configuration when the owner
   * confirms having saved it (`null`); only its hash stays.
   */
  recoveryKey: string | null;
}

export type RandomBytes = (size: number) => Buffer;

/** URL- and SQL-safe text: letters, digits, `-` and `_`. */
const token = (random: RandomBytes, bytes: number) => random(bytes).toString('base64url');

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
    recoveryKey,
  };
}
