/**
 * Port for the key-encryption key (KEK). The KEK never leaves the key service: it only wraps and
 * unwraps the per-tenant data keys (DEKs) that encrypt the fields (design, "Encryption and secrets").
 *
 * Two adapters implement it: `adapters/local-kek` (development and tests, key from the
 * environment) and `adapters/aws-kms` (production). The tenant id travels with every call as the
 * encryption context, so a wrapped key issued for one tenant cannot be unwrapped for another.
 */

export type KeyPurpose = 'tenant-dek';

export interface KeyContext {
  tenantId: string;
  purpose: KeyPurpose;
}

export interface DataKey {
  /** The 32-byte key, for use in memory only. Never persisted. */
  plaintext: Buffer;
  /** The same key encrypted by the KEK. This is what gets stored. */
  wrapped: Buffer;
  /** Which KEK wrapped it, so keys can be re-wrapped when the KEK rotates. */
  kekId: string;
}

export interface KeyManagement {
  generateDataKey(context: KeyContext): Promise<DataKey>;
  unwrapDataKey(wrapped: Buffer, context: KeyContext): Promise<Buffer>;
}

/** Any failure of the key service. The message is generic: it never names keys or tenants. */
export class KeyManagementError extends Error {
  constructor() {
    super('The key management service could not complete the request');
    this.name = 'KeyManagementError';
  }
}
