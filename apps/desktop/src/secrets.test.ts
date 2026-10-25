import { describe, expect, it } from 'vitest';

import { unwrapBackupKey, verifyRecoveryKey } from './backup-crypto.js';
import { formatRecoveryKey, generateRecoveryKey } from './recovery-key.js';
import { generateSecrets, newRecoveryKey, normalizeRecoveryKey } from './secrets.js';

describe('the secrets of an install', () => {
  it('are random, different on every call and long enough for what the API demands', () => {
    const first = generateSecrets();
    const second = generateSecrets();

    expect(Buffer.from(first.kmsLocalKekBase64, 'base64')).toHaveLength(32);
    expect(first.addressHashPepper.length).toBeGreaterThanOrEqual(32);
    expect(first.storageUploadSecret.length).toBeGreaterThanOrEqual(32);
    expect(first.kmsLocalKekBase64).not.toBe(second.kmsLocalKekBase64);
    expect(first.appRwPassword).not.toBe(second.appRwPassword);
    expect(first.backupKeyBase64).not.toBe(second.backupKeyBase64);
  });

  it('use only characters that are safe in an SQL literal and in a connection URL', () => {
    const secrets = generateSecrets();

    for (const password of [
      secrets.pgSuperuserPassword,
      secrets.appOwnerPassword,
      secrets.appRwPassword,
      secrets.auditSealerPassword,
    ]) {
      expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(secrets.addressHashPepper).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secrets.storageUploadSecret).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never hold the recovery key: only the wrap of the backup key and a hash to check it', () => {
    const secrets = generateSecrets();

    expect(secrets.recoveryKey).toBeNull();
    expect(Buffer.from(secrets.backupKeyBase64, 'base64')).toHaveLength(32);
    expect(JSON.stringify(secrets)).not.toMatch(/[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-/);
  });

  it('make a recovery key for the backup key that unwraps it and is checked by its hash', () => {
    const secrets = generateSecrets();

    const fresh = newRecoveryKey(secrets.backupKeyBase64);

    expect(unwrapBackupKey(fresh.backupKeyWrap, fresh.recoveryKey).toString('base64')).toBe(
      secrets.backupKeyBase64,
    );
    expect(verifyRecoveryKey(fresh.recoveryKey, fresh.recoveryKeyHash)).toBe(true);
    expect(fresh.recoveryKeyHash).not.toContain(normalizeRecoveryKey(fresh.recoveryKey));
    // And it is a different key every time.
    expect(newRecoveryKey(secrets.backupKeyBase64).recoveryKey).not.toBe(fresh.recoveryKey);
  });
});

describe('the recovery key', () => {
  it('has six groups of five unambiguous characters', () => {
    expect(generateRecoveryKey()).toMatch(/^([A-HJ-NP-Z2-9]{5}-){5}[A-HJ-NP-Z2-9]{5}$/);
  });

  it('draws every letter evenly from the random bytes', () => {
    // Bytes of 224 or more are skipped, so a plain modulo does not favour the first letters.
    const counts = new Map<string, number>();
    for (let round = 0; round < 400; round += 1) {
      for (const character of generateRecoveryKey().replaceAll('-', '')) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
    }

    expect(counts.size).toBe(32);
    for (const count of counts.values()) {
      // 12,000 draws over 32 letters: about 375 each.
      expect(count).toBeGreaterThan(250);
      expect(count).toBeLessThan(500);
    }
  });

  it('is normalized as typed (no dashes or spaces, upper case) and shown in groups of five', () => {
    expect(normalizeRecoveryKey(' abcde-fghjk ')).toBe('ABCDEFGHJK');
    expect(formatRecoveryKey('abcdefghjkmnpqrstuvwxyz234567')).toBe(
      'ABCDE-FGHJK-MNPQR-STUVW-XYZ23-4567',
    );
  });
});
