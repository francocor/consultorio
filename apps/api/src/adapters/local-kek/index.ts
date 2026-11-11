import { randomBytes } from 'node:crypto';

import { DecryptionError, decrypt, encrypt, type Aad } from '../../platform/crypto/aes-gcm.js';
import {
  KeyManagementError,
  type DataKey,
  type KeyContext,
  type KeyManagement,
} from '../../platform/crypto/key-management.js';

const KEK_BYTES = 32;
const KEK_ID = 'local-v1';

/** The wrapped key is authenticated against the tenant and purpose, like a KMS encryption context. */
function contextAad(context: KeyContext): Aad {
  return {
    tenantId: context.tenantId,
    table: 'tenant_key',
    column: 'dek_wrapped',
    rowId: context.purpose,
  };
}

/**
 * Key management for development and tests: the KEK comes from the environment
 * (`KMS_LOCAL_KEK_BASE64`) and wraps data keys with AES-256-GCM. The production configuration
 * refuses this adapter, because a KEK that sits next to the data protects nothing.
 */
export function createLocalKeyManagement(kekBase64: string): KeyManagement {
  const kek = Buffer.from(kekBase64, 'base64');
  if (kek.length !== KEK_BYTES) {
    throw new Error(`The local KEK must be ${String(KEK_BYTES)} bytes`);
  }

  return {
    generateDataKey(context): Promise<DataKey> {
      const plaintext = randomBytes(KEK_BYTES);
      const wrapped = encrypt(kek, plaintext, contextAad(context));
      return Promise.resolve({ plaintext, wrapped, kekId: KEK_ID });
    },

    unwrapDataKey(wrapped, context): Promise<Buffer> {
      try {
        return Promise.resolve(decrypt(kek, wrapped, contextAad(context)));
      } catch (error) {
        if (error instanceof DecryptionError) return Promise.reject(new KeyManagementError());
        throw error;
      }
    },
  };
}
