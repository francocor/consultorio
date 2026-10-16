import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DecryptionError,
  FORMAT_VERSION,
  decrypt,
  encrypt,
  readKeyVersion,
  type Aad,
} from './aes-gcm.js';

const KEY = randomBytes(32);
const AAD: Aad = {
  tenantId: '0190a000-0000-7000-8000-00000000000a',
  table: 'clinical_note',
  column: 'draft_content_enc',
  rowId: '0190a000-0000-7000-8000-0000000000d1',
};

describe('AES-256-GCM field encryption', () => {
  it('round-trips text and binary data', () => {
    const text = encrypt(KEY, 'Paciente refiere dolor torácico', AAD);
    const binary = encrypt(KEY, Buffer.from([0, 1, 2, 255, 254]), AAD);

    expect(decrypt(KEY, text, AAD).toString('utf8')).toBe('Paciente refiere dolor torácico');
    expect([...decrypt(KEY, binary, AAD)]).toEqual([0, 1, 2, 255, 254]);
  });

  it('round-trips an empty value', () => {
    expect(decrypt(KEY, encrypt(KEY, '', AAD), AAD).length).toBe(0);
  });

  it('does not contain the plaintext in the output', () => {
    const blob = encrypt(KEY, 'secret-diagnosis', AAD);

    expect(blob.includes(Buffer.from('secret-diagnosis'))).toBe(false);
  });

  it('writes a versioned header: format byte, key version, then a 96-bit nonce', () => {
    const blob = encrypt(KEY, 'x', AAD, 7);

    expect(blob[0]).toBe(FORMAT_VERSION);
    expect(readKeyVersion(blob)).toBe(7);
    // header (1 + 2) + nonce (12) + ciphertext (1) + tag (16)
    expect(blob.length).toBe(1 + 2 + 12 + 1 + 16);
  });

  it('defaults the key version to 1', () => {
    expect(readKeyVersion(encrypt(KEY, 'x', AAD))).toBe(1);
  });

  it('never repeats a nonce, so equal plaintexts give different ciphertexts', () => {
    const nonces = new Set<string>();
    const first = encrypt(KEY, 'same', AAD);
    const second = encrypt(KEY, 'same', AAD);

    for (let i = 0; i < 20_000; i += 1) {
      nonces.add(encrypt(KEY, 'n', AAD).subarray(3, 15).toString('hex'));
    }

    expect(first.equals(second)).toBe(false);
    expect(nonces.size).toBe(20_000);
  });

  it('rejects a ciphertext that was tampered with, wherever the byte flip lands', () => {
    const blob = encrypt(KEY, 'integrity matters', AAD);

    for (const index of [0, 1, 2, 3, 10, 15, 16, blob.length - 1]) {
      const copy = Buffer.from(blob);
      copy[index] = (copy[index] ?? 0) ^ 0x01;
      expect(() => decrypt(KEY, copy, AAD), `byte ${String(index)}`).toThrow(DecryptionError);
    }
  });

  it.each([
    ['a different tenant', { tenantId: '0190a000-0000-7000-8000-00000000000b' }],
    ['a different table', { table: 'addendum' }],
    ['a different column', { column: 'content_enc' }],
    ['a different row', { rowId: '0190a000-0000-7000-8000-0000000000d2' }],
  ])('rejects the same ciphertext bound to %s (AAD mismatch)', (_label, change) => {
    const blob = encrypt(KEY, 'bound to its row', AAD);

    expect(() => decrypt(KEY, blob, { ...AAD, ...change })).toThrow(DecryptionError);
  });

  it('rejects the wrong key', () => {
    const blob = encrypt(KEY, 'x', AAD);

    expect(() => decrypt(randomBytes(32), blob, AAD)).toThrow(DecryptionError);
  });

  it('rejects an unknown format version and truncated input', () => {
    const blob = encrypt(KEY, 'x', AAD);
    const future = Buffer.from(blob);
    future[0] = 99;

    expect(() => decrypt(KEY, future, AAD)).toThrow(DecryptionError);
    expect(() => decrypt(KEY, blob.subarray(0, 10), AAD)).toThrow(DecryptionError);
    expect(() => decrypt(KEY, Buffer.alloc(0), AAD)).toThrow(DecryptionError);
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => encrypt(randomBytes(16), 'x', AAD)).toThrow(/32 bytes/);
    expect(() => decrypt(randomBytes(31), encrypt(KEY, 'x', AAD), AAD)).toThrow(/32 bytes/);
  });

  it('never puts the plaintext or the key into an error message', () => {
    const blob = encrypt(KEY, 'secret-diagnosis', AAD);
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 0xff;

    let message = '';
    try {
      decrypt(KEY, blob, AAD);
    } catch (error) {
      message = String(error);
    }

    expect(message).not.toContain('secret-diagnosis');
    expect(message).not.toContain(KEY.toString('hex'));
    expect(message).not.toContain(AAD.rowId);
  });
});
