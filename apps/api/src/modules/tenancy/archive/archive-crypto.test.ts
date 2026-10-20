import { describe, expect, it } from 'vitest';

import {
  generateReleaserKeys,
  generateTenantKeyPair,
  openObject,
  releaserPublicKeyOf,
  sealObject,
  unwrapPrivateKey,
  wrapPrivateKey,
} from './archive-crypto.js';

const TENANT = '0190a000-0000-7000-8000-000000000001';
const OTHER_TENANT = '0190a000-0000-7000-8000-000000000002';
const NAME = `t/${TENANT}/run-1/administrative-000001.enc`;

// RSA 3072 takes a moment to generate: the pairs are made once for the whole file.
const tenantKeys = await generateTenantKeyPair();
const strangerKeys = await generateTenantKeyPair();
const releaser = generateReleaserKeys();

describe('the keys of the releaser', () => {
  it('makes a pair of 32-byte keys in base64, and derives the public one from the private one', () => {
    expect(Buffer.from(releaser.kek, 'base64')).toHaveLength(32);
    expect(Buffer.from(releaser.publicKey, 'base64')).toHaveLength(32);
    expect(releaserPublicKeyOf(releaser.kek)).toBe(releaser.publicKey);
    expect(generateReleaserKeys().kek).not.toBe(releaser.kek);
  });

  it('refuses a key that is not 32 bytes of base64', () => {
    expect(() => releaserPublicKeyOf('too-short')).toThrow(/32 bytes/);
    expect(() => releaserPublicKeyOf(Buffer.alloc(31).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('the private key of an organization', () => {
  const aad = { tenantId: TENANT, version: 1 };

  it('is wrapped for the releaser and opened only with its key', () => {
    const wrapped = wrapPrivateKey(tenantKeys.privateKey, releaser.publicKey, aad);

    expect(wrapped.equals(tenantKeys.privateKey)).toBe(false);
    expect(wrapped.includes(tenantKeys.privateKey.subarray(40, 80))).toBe(false);
    expect(unwrapPrivateKey(wrapped, releaser.kek, aad).equals(tenantKeys.privateKey)).toBe(true);
    // A fresh envelope every time: the wrapping is randomized.
    expect(wrapPrivateKey(tenantKeys.privateKey, releaser.publicKey, aad).equals(wrapped)).toBe(
      false,
    );
  });

  it('is unusable with another key, with the public key of the releaser, or with nothing', () => {
    const wrapped = wrapPrivateKey(tenantKeys.privateKey, releaser.publicKey, aad);
    const other = generateReleaserKeys();

    expect(() => unwrapPrivateKey(wrapped, other.kek, aad)).toThrow();
    // What the API and the worker hold (the public half) opens nothing.
    expect(() => unwrapPrivateKey(wrapped, releaser.publicKey, aad)).toThrow();
    expect(() => unwrapPrivateKey(Buffer.alloc(0), releaser.kek, aad)).toThrow();
  });

  it('is bound to its organization and version: the same bytes under another row open nothing', () => {
    const wrapped = wrapPrivateKey(tenantKeys.privateKey, releaser.publicKey, aad);

    expect(() =>
      unwrapPrivateKey(wrapped, releaser.kek, { ...aad, tenantId: OTHER_TENANT }),
    ).toThrow();
    expect(() => unwrapPrivateKey(wrapped, releaser.kek, { ...aad, version: 2 })).toThrow();
  });

  it('detects a changed byte anywhere in the envelope', () => {
    const wrapped = wrapPrivateKey(tenantKeys.privateKey, releaser.publicKey, aad);
    for (const position of [0, 33, 48, wrapped.length - 1]) {
      const altered = Buffer.from(wrapped);
      altered[position] = (altered[position] ?? 0) ^ 0x01;
      expect(() => unwrapPrivateKey(altered, releaser.kek, aad), String(position)).toThrow();
    }
  });
});

describe('an archived object', () => {
  const plain = Buffer.from('Registros clínicos de una organización dada de baja. '.repeat(500));
  const context = { tenantId: TENANT, name: NAME, keyVersion: 1 };

  it('is encrypted with a fresh data key and opened with the private key of the organization', () => {
    const sealed = sealObject(plain, tenantKeys.publicKey, context);

    expect(sealed.length).toBeGreaterThan(plain.length);
    expect(sealed.includes(Buffer.from('Registros clínicos'))).toBe(false);
    expect(openObject(sealed, tenantKeys.privateKey, context).equals(plain)).toBe(true);
    // Two seals of the same bytes share nothing: another data key and another nonce each time.
    expect(sealObject(plain, tenantKeys.publicKey, context).equals(sealed)).toBe(false);
  });

  it('can be written with the public key alone, and the public key opens nothing', () => {
    const sealed = sealObject(plain, tenantKeys.publicKey, context);

    // The writer holds only the public key: it cannot do the one thing the archive forbids it.
    expect(() => openObject(sealed, tenantKeys.publicKey, context)).toThrow();
    expect(() => openObject(sealed, strangerKeys.privateKey, context)).toThrow();
  });

  it('is bound to its place: the object moved to another name, organization or key version opens nothing', () => {
    const sealed = sealObject(plain, tenantKeys.publicKey, context);

    expect(() =>
      openObject(sealed, tenantKeys.privateKey, { ...context, name: `${NAME}.copy` }),
    ).toThrow();
    expect(() =>
      openObject(sealed, tenantKeys.privateKey, { ...context, tenantId: OTHER_TENANT }),
    ).toThrow();
    expect(() =>
      openObject(sealed, tenantKeys.privateKey, { ...context, keyVersion: 2 }),
    ).toThrow();
  });

  it('detects a changed byte in the header, the wrapped key, the nonce, the tag or the data', () => {
    const sealed = sealObject(plain, tenantKeys.publicKey, context);
    const wrappedKeyEnd = 4 + 1 + 4 + 2 + 384;
    for (const position of [
      0,
      4,
      6,
      12,
      wrappedKeyEnd - 1,
      wrappedKeyEnd + 3,
      wrappedKeyEnd + 14,
      sealed.length - 1,
    ]) {
      const altered = Buffer.from(sealed);
      altered[position] = (altered[position] ?? 0) ^ 0x80;
      expect(() => openObject(altered, tenantKeys.privateKey, context), String(position)).toThrow();
    }
  });

  it('refuses something that is not an archived object, and a truncated one', () => {
    expect(() => openObject(Buffer.from('not an archive'), tenantKeys.privateKey, context)).toThrow(
      /not an archived object/,
    );
    const sealed = sealObject(plain, tenantKeys.publicKey, context);
    expect(() => openObject(sealed.subarray(0, 100), tenantKeys.privateKey, context)).toThrow();
  });

  it('seals and opens an empty object', () => {
    const sealed = sealObject(Buffer.alloc(0), tenantKeys.publicKey, context);

    expect(openObject(sealed, tenantKeys.privateKey, context)).toHaveLength(0);
  });
});
