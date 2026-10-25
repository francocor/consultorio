import { describe, expect, it } from 'vitest';

import { generateSecrets, normalizeRecoveryKey } from './secrets.js';

describe('the secrets of an install', () => {
  it('are random, different on every call and long enough for what the API demands', () => {
    const first = generateSecrets();
    const second = generateSecrets();

    expect(Buffer.from(first.kmsLocalKekBase64, 'base64')).toHaveLength(32);
    expect(first.addressHashPepper.length).toBeGreaterThanOrEqual(32);
    expect(first.storageUploadSecret.length).toBeGreaterThanOrEqual(32);
    expect(first.kmsLocalKekBase64).not.toBe(second.kmsLocalKekBase64);
    expect(first.appRwPassword).not.toBe(second.appRwPassword);
    expect(new Set(Object.values(first)).size).toBe(Object.values(first).length);
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

  it('give a recovery key of six groups of five unambiguous characters', () => {
    const { recoveryKey } = generateSecrets();

    expect(recoveryKey).toMatch(/^([A-HJ-NP-Z2-9]{5}-){5}[A-HJ-NP-Z2-9]{5}$/);
  });

  it('draw every letter of the recovery key evenly from the random bytes', () => {
    // Bytes of 224 or more are skipped, so a plain modulo does not favour the first letters.
    const counts = new Map<string, number>();
    for (let round = 0; round < 400; round += 1) {
      for (const character of generateSecrets().recoveryKey.replaceAll('-', '')) {
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

  it('normalizes a typed recovery key: no dashes or spaces, upper case', () => {
    expect(normalizeRecoveryKey(' abcde-fghjk ')).toBe('ABCDEFGHJK');
  });
});
