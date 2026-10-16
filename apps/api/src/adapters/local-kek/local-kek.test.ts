import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { KeyManagementError, type KeyContext } from '../../platform/crypto/key-management.js';

import { createLocalKeyManagement } from './index.js';

const TENANT_A: KeyContext = {
  tenantId: '0190a000-0000-7000-8000-00000000000a',
  purpose: 'tenant-dek',
};
const TENANT_B: KeyContext = {
  tenantId: '0190a000-0000-7000-8000-00000000000b',
  purpose: 'tenant-dek',
};

function kms(kek = randomBytes(32)) {
  return createLocalKeyManagement(kek.toString('base64'));
}

describe('local key management (development and tests)', () => {
  it('generates a 32-byte data key and returns it wrapped', async () => {
    const key = await kms().generateDataKey(TENANT_A);

    expect(key.plaintext).toHaveLength(32);
    expect(key.wrapped.length).toBeGreaterThan(32);
    expect(key.wrapped.includes(key.plaintext)).toBe(false);
    expect(key.kekId).toBe('local-v1');
  });

  it('unwraps what it wrapped', async () => {
    const service = kms();
    const key = await service.generateDataKey(TENANT_A);

    const unwrapped = await service.unwrapDataKey(key.wrapped, TENANT_A);

    expect(unwrapped.equals(key.plaintext)).toBe(true);
  });

  it('generates a different key every time', async () => {
    const service = kms();

    const first = await service.generateDataKey(TENANT_A);
    const second = await service.generateDataKey(TENANT_A);

    expect(first.plaintext.equals(second.plaintext)).toBe(false);
    expect(first.wrapped.equals(second.wrapped)).toBe(false);
  });

  it('will not unwrap a key for another tenant (the tenant is the encryption context)', async () => {
    const service = kms();
    const key = await service.generateDataKey(TENANT_A);

    await expect(service.unwrapDataKey(key.wrapped, TENANT_B)).rejects.toBeInstanceOf(
      KeyManagementError,
    );
  });

  it('will not unwrap with a different KEK', async () => {
    const key = await kms().generateDataKey(TENANT_A);

    await expect(kms().unwrapDataKey(key.wrapped, TENANT_A)).rejects.toBeInstanceOf(
      KeyManagementError,
    );
  });

  it('will not unwrap a tampered wrapped key', async () => {
    const service = kms();
    const key = await service.generateDataKey(TENANT_A);
    key.wrapped[key.wrapped.length - 1] = (key.wrapped[key.wrapped.length - 1] ?? 0) ^ 1;

    await expect(service.unwrapDataKey(key.wrapped, TENANT_A)).rejects.toBeInstanceOf(
      KeyManagementError,
    );
  });

  it('rejects a KEK that is not 32 bytes of base64', () => {
    expect(() => createLocalKeyManagement('c2hvcnQ=')).toThrow(/32 bytes/);
  });

  it('keeps error messages free of identifiers', async () => {
    const service = kms();
    const key = await service.generateDataKey(TENANT_A);

    const error = await service
      .unwrapDataKey(key.wrapped, TENANT_B)
      .catch((caught: unknown) => caught);

    expect(String(error)).not.toContain(TENANT_A.tenantId);
    expect(String(error)).not.toContain(TENANT_B.tenantId);
  });
});
