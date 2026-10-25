import { randomBytes } from 'node:crypto';

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
  /** Opens the secrets inside a backup on another PC. Shown to the owner once. */
  recoveryKey: string;
}

export type RandomBytes = (size: number) => Buffer;

/** URL- and SQL-safe text: letters, digits, `-` and `_`. */
const token = (random: RandomBytes, bytes: number) => random(bytes).toString('base64url');

/** Letters and digits without the ones that look alike (0/O, 1/I). */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_GROUPS = 6;
const RECOVERY_GROUP_SIZE = 5;

/** `ABCDE-FGHJK-...`: 6 groups of 5, 150 bits. */
function recoveryKey(random: RandomBytes): string {
  const groups: string[] = [];
  for (let group = 0; group < RECOVERY_GROUPS; group += 1) {
    let text = '';
    while (text.length < RECOVERY_GROUP_SIZE) {
      // 224 is the largest multiple of 32 under 256, so every letter is equally likely.
      for (const byte of random(16)) {
        if (byte < 224 && text.length < RECOVERY_GROUP_SIZE) {
          text += RECOVERY_ALPHABET.charAt(byte % RECOVERY_ALPHABET.length);
        }
      }
    }
    groups.push(text);
  }
  return groups.join('-');
}

/** The recovery key as typed: without dashes or spaces, upper case. */
export function normalizeRecoveryKey(typed: string): string {
  return typed.replace(/[\s-]/g, '').toUpperCase();
}

export function generateSecrets(random: RandomBytes = randomBytes): InstallSecrets {
  return {
    pgSuperuserPassword: token(random, 32),
    appOwnerPassword: token(random, 32),
    appRwPassword: token(random, 32),
    auditSealerPassword: token(random, 32),
    kmsLocalKekBase64: random(32).toString('base64'),
    addressHashPepper: token(random, 36),
    storageUploadSecret: token(random, 36),
    recoveryKey: recoveryKey(random),
  };
}
