import { randomBytes } from 'node:crypto';

import { DecryptCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { describe, expect, it, vi } from 'vitest';

import { KeyManagementError, type KeyContext } from '../../platform/crypto/key-management.js';

import { createAwsKeyManagement, type KmsClientLike } from './index.js';

const CONTEXT: KeyContext = {
  tenantId: '0190a000-0000-7000-8000-00000000000a',
  purpose: 'tenant-dek',
};
const KEY_ID = 'arn:aws:kms:sa-east-1:111122223333:key/example';

/** A KMS client double that answers each command from a script and records what was sent. */
function fakeClient(responses: unknown[]) {
  const send = vi.fn<(command: unknown) => Promise<unknown>>();
  for (const response of responses) {
    if (response instanceof Error) send.mockRejectedValueOnce(response);
    else send.mockResolvedValueOnce(response);
  }
  const client: KmsClientLike = { send };
  return { client, send };
}

describe('AWS KMS key management (mocked client)', () => {
  it('asks KMS for an AES-256 data key under the KEK, with the tenant in the encryption context', async () => {
    const plaintext = randomBytes(32);
    const wrapped = randomBytes(184);
    const { client, send } = fakeClient([
      {
        Plaintext: new Uint8Array(plaintext),
        CiphertextBlob: new Uint8Array(wrapped),
        KeyId: KEY_ID,
      },
    ]);

    const key = await createAwsKeyManagement(client, KEY_ID).generateDataKey(CONTEXT);

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GenerateDataKeyCommand);
    expect((command as GenerateDataKeyCommand).input).toEqual({
      KeyId: KEY_ID,
      KeySpec: 'AES_256',
      EncryptionContext: { tenant_id: CONTEXT.tenantId, purpose: 'tenant-dek' },
    });
    expect(key.plaintext.equals(plaintext)).toBe(true);
    expect(key.wrapped.equals(wrapped)).toBe(true);
    expect(key.kekId).toBe(KEY_ID);
  });

  it('unwraps with the same encryption context, so KMS itself refuses another tenant', async () => {
    const plaintext = randomBytes(32);
    const wrapped = randomBytes(184);
    const { client, send } = fakeClient([{ Plaintext: new Uint8Array(plaintext), KeyId: KEY_ID }]);

    const unwrapped = await createAwsKeyManagement(client, KEY_ID).unwrapDataKey(wrapped, CONTEXT);

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(DecryptCommand);
    const input = (command as DecryptCommand).input;
    expect(Buffer.from(input.CiphertextBlob ?? new Uint8Array()).equals(wrapped)).toBe(true);
    expect(input.KeyId).toBe(KEY_ID);
    expect(input.EncryptionContext).toEqual({ tenant_id: CONTEXT.tenantId, purpose: 'tenant-dek' });
    expect(unwrapped.equals(plaintext)).toBe(true);
  });

  it('turns a KMS failure into a generic error that carries no AWS detail', async () => {
    const failure = Object.assign(new Error('AccessDeniedException for arn:aws:kms:secret'), {
      name: 'AccessDeniedException',
    });
    const { client } = fakeClient([failure, failure]);
    const service = createAwsKeyManagement(client, KEY_ID);

    const generate = await service.generateDataKey(CONTEXT).catch((caught: unknown) => caught);
    const unwrap = await service
      .unwrapDataKey(randomBytes(10), CONTEXT)
      .catch((caught: unknown) => caught);

    for (const error of [generate, unwrap]) {
      expect(error).toBeInstanceOf(KeyManagementError);
      expect(String(error)).not.toContain('arn:aws');
    }
  });

  it('refuses a data key of the wrong size or a response without key material', async () => {
    const { client } = fakeClient([
      { Plaintext: new Uint8Array(16), CiphertextBlob: new Uint8Array(10) },
      { CiphertextBlob: new Uint8Array(10) },
      {},
    ]);
    const service = createAwsKeyManagement(client, KEY_ID);

    await expect(service.generateDataKey(CONTEXT)).rejects.toBeInstanceOf(KeyManagementError);
    await expect(service.generateDataKey(CONTEXT)).rejects.toBeInstanceOf(KeyManagementError);
    await expect(service.unwrapDataKey(randomBytes(10), CONTEXT)).rejects.toBeInstanceOf(
      KeyManagementError,
    );
  });
});
