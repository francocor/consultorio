import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
  type DecryptCommandOutput,
  type GenerateDataKeyCommandOutput,
} from '@aws-sdk/client-kms';

import {
  KeyManagementError,
  type DataKey,
  type KeyContext,
  type KeyManagement,
} from '../../platform/crypto/key-management.js';

const DEK_BYTES = 32;

/** The only part of the AWS client the adapter uses, so tests can pass a double. */
export interface KmsClientLike {
  send(command: GenerateDataKeyCommand | DecryptCommand): Promise<unknown>;
}

/** The tenant travels as the KMS encryption context: KMS refuses to decrypt under another one. */
function encryptionContext(context: KeyContext): Record<string, string> {
  return { tenant_id: context.tenantId, purpose: context.purpose };
}

/**
 * Production key management on AWS KMS. The KEK lives in KMS and is never exported. A data key is
 * produced by `GenerateDataKey` (AES-256) and wrapped by KMS under the tenant's encryption
 * context; every unwrap goes back to KMS, so IAM and CloudTrail see each use. Any AWS failure is
 * reported as a generic `KeyManagementError`: AWS messages can name ARNs and accounts.
 */
export function createAwsKeyManagement(client: KmsClientLike, keyId: string): KeyManagement {
  return {
    async generateDataKey(context): Promise<DataKey> {
      let output: GenerateDataKeyCommandOutput;
      try {
        output = (await client.send(
          new GenerateDataKeyCommand({
            KeyId: keyId,
            KeySpec: 'AES_256',
            EncryptionContext: encryptionContext(context),
          }),
        )) as GenerateDataKeyCommandOutput;
      } catch {
        throw new KeyManagementError();
      }
      if (output.Plaintext?.length !== DEK_BYTES || !output.CiphertextBlob) {
        throw new KeyManagementError();
      }
      return {
        plaintext: Buffer.from(output.Plaintext),
        wrapped: Buffer.from(output.CiphertextBlob),
        kekId: keyId,
      };
    },

    async unwrapDataKey(wrapped, context): Promise<Buffer> {
      let output: DecryptCommandOutput;
      try {
        output = (await client.send(
          new DecryptCommand({
            CiphertextBlob: wrapped,
            KeyId: keyId,
            EncryptionContext: encryptionContext(context),
          }),
        )) as DecryptCommandOutput;
      } catch {
        throw new KeyManagementError();
      }
      if (output.Plaintext?.length !== DEK_BYTES) throw new KeyManagementError();
      return Buffer.from(output.Plaintext);
    },
  };
}

/** Builds the real AWS client for a region. Credentials come from the default provider chain. */
export function createKmsClient(region: string): KmsClientLike {
  return new KMSClient({ region });
}
