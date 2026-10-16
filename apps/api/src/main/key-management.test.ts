import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createKeyManagement } from './key-management.js';

const CONTEXT = {
  tenantId: '0190a000-0000-7000-8000-00000000000a',
  purpose: 'tenant-dek',
} as const;

describe('createKeyManagement', () => {
  it('builds the local adapter from the local configuration and it wraps and unwraps', async () => {
    const kms = createKeyManagement({
      provider: 'local',
      kekBase64: randomBytes(32).toString('base64'),
    });

    const key = await kms.generateDataKey(CONTEXT);
    const unwrapped = await kms.unwrapDataKey(key.wrapped, CONTEXT);

    expect(key.kekId).toBe('local-v1');
    expect(unwrapped.equals(key.plaintext)).toBe(true);
  });

  it('builds the AWS adapter from the AWS configuration without contacting AWS', () => {
    const kms = createKeyManagement({
      provider: 'aws',
      region: 'sa-east-1',
      keyId: 'alias/consultorio-tenant-kek',
    });

    expect(typeof kms.generateDataKey).toBe('function');
    expect(typeof kms.unwrapDataKey).toBe('function');
  });

  it('refuses a malformed local KEK at startup rather than at first use', () => {
    expect(() => createKeyManagement({ provider: 'local', kekBase64: 'c2hvcnQ=' })).toThrow(
      /32 bytes/,
    );
  });
});
