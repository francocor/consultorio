import { decrypt, encrypt, type Aad } from '../../../platform/crypto/aes-gcm.js';
import type { KeyManagement } from '../../../platform/crypto/key-management.js';

/** An operator belongs to no organization: the key service sees the nil UUID as the tenant. */
const PLATFORM_SCOPE = '00000000-0000-0000-0000-000000000000';

const aadFor = (operatorId: string): Aad => ({
  tenantId: PLATFORM_SCOPE,
  table: 'operator_user',
  column: 'totp_secret_enc',
  rowId: operatorId,
});

export interface SealedSecret {
  /** The data key, wrapped by the key service. */
  dekWrapped: Buffer;
  /** The secret encrypted with that data key, bound to the operator row. */
  encrypted: Buffer;
}

/**
 * Envelope encryption of an operator's TOTP secret. Each operator has their own data key, wrapped
 * by the key service, so a database dump alone does not open any second factor, and a blob copied
 * to another operator's row fails to decrypt (the row id is part of the authenticated data).
 */
export interface OperatorSecrets {
  seal(operatorId: string, secret: Uint8Array): Promise<SealedSecret>;
  open(operatorId: string, sealed: SealedSecret): Promise<Uint8Array>;
}

export function createOperatorSecrets(kms: KeyManagement): OperatorSecrets {
  const context = { tenantId: PLATFORM_SCOPE, purpose: 'operator-dek' } as const;

  return {
    async seal(operatorId, secret) {
      const key = await kms.generateDataKey(context);
      try {
        return {
          dekWrapped: key.wrapped,
          encrypted: encrypt(key.plaintext, Buffer.from(secret), aadFor(operatorId)),
        };
      } finally {
        key.plaintext.fill(0);
      }
    },

    async open(operatorId, sealed) {
      const key = await kms.unwrapDataKey(sealed.dekWrapped, context);
      try {
        return new Uint8Array(decrypt(key, sealed.encrypted, aadFor(operatorId)));
      } finally {
        key.fill(0);
      }
    },
  };
}
