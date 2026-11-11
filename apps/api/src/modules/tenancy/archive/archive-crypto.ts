import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPair,
  generateKeyPairSync,
  hkdfSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { promisify } from 'node:util';

/**
 * The cryptography of the retention archive, with no database and no storage in it (tenancy,
 * "Retention archive after cancellation"). Two layers, built so that the processes that WRITE the
 * archive can never READ it:
 *
 * 1. **Every archived object** is encrypted with a fresh AES-256-GCM data key, and that data key is
 *    encrypted (RSA-OAEP, SHA-256) with the PUBLIC key of the organization. Writing needs the public
 *    key and nothing else; opening needs the private key.
 * 2. **The private key of an organization** is stored sealed to the RELEASER, the one process that
 *    may read the archive: an X25519 sealed box (an ephemeral key agreement, HKDF, AES-256-GCM)
 *    addressed to the public key of the releaser. The API and the worker know that public key, so
 *    they can create an organization's key pair and seal its private half, and cannot open it again.
 *    `ARCHIVE_RELEASER_KEK` (the private half, 32 bytes in base64) exists only in the releaser's
 *    environment.
 *
 * Every ciphertext is bound to where it belongs (organization, object name, key version) through the
 * authenticated data, so moving an object or a row to another place opens nothing. All the formats
 * start with a version byte; a change of format is a new version, never an edit.
 */

const generateKeyPairAsync = promisify(generateKeyPair);

const RSA_BITS = 3072;
const OBJECT_MAGIC = Buffer.from('ARCH');
const FORMAT_VERSION = 1;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const X25519_BYTES = 32;
const WRAP_INFO = 'consultorio/archive-key-wrap/v1';
/** The fixed prefix of a PKCS#8 X25519 private key: the raw 32 bytes follow. */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function fromBase64(value: string, what: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== X25519_BYTES) throw new Error(`${what} must be 32 bytes in base64`);
  return bytes;
}

function x25519Private(raw: Buffer) {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

function x25519Public(raw: Buffer) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') },
    format: 'jwk',
  });
}

function rawPublicOf(privateRaw: Buffer): Buffer {
  const jwk = createPublicKey(x25519Private(privateRaw)).export({ format: 'jwk' });
  return Buffer.from(jwk.x ?? '', 'base64url');
}

/** A new pair for the releaser: `kek` goes to the releaser alone, `publicKey` to the processes that write. */
export function generateReleaserKeys(): { kek: string; publicKey: string } {
  const pair = generateKeyPairSync('x25519');
  const jwk = pair.privateKey.export({ format: 'jwk' });
  return {
    kek: Buffer.from(jwk.d ?? '', 'base64url').toString('base64'),
    publicKey: Buffer.from(jwk.x ?? '', 'base64url').toString('base64'),
  };
}

/** The public key (base64) that goes with a releaser key. */
export function releaserPublicKeyOf(kek: string): string {
  return rawPublicOf(fromBase64(kek, 'The releaser key')).toString('base64');
}

export interface TenantKeyPair {
  /** SPKI DER. */
  publicKey: Buffer;
  /** PKCS#8 DER. It exists only here, long enough to be wrapped for the releaser. */
  privateKey: Buffer;
}

/** A new RSA-OAEP pair for an organization. Asynchronous: generating 3072 bits is not quick. */
export async function generateTenantKeyPair(): Promise<TenantKeyPair> {
  const pair = await generateKeyPairAsync('rsa', {
    modulusLength: RSA_BITS,
    publicExponent: 0x10001,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

export interface WrapContext {
  tenantId: string;
  version: number;
}

const wrapAad = (context: WrapContext) =>
  Buffer.from(`archive-key|v1|${context.tenantId}|${String(context.version)}`);

function wrapKey(shared: Buffer, ephemeralPublic: Buffer, recipientPublic: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([ephemeralPublic, recipientPublic]), WRAP_INFO, 32),
  );
}

/**
 * Seals the private key of an organization to the releaser. Envelope: version (1) | ephemeral public
 * key (32) | nonce (12) | tag (16) | ciphertext.
 */
export function wrapPrivateKey(
  privateKey: Buffer,
  releaserPublicKey: string,
  context: WrapContext,
): Buffer {
  const recipient = fromBase64(releaserPublicKey, 'The public key of the releaser');
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublic = Buffer.from(
    ephemeral.publicKey.export({ format: 'jwk' }).x ?? '',
    'base64url',
  );
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: x25519Public(recipient),
  });
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', wrapKey(shared, ephemeralPublic, recipient), iv);
  cipher.setAAD(wrapAad(context));
  const data = Buffer.concat([cipher.update(privateKey), cipher.final()]);
  return Buffer.concat([
    Buffer.from([FORMAT_VERSION]),
    ephemeralPublic,
    iv,
    cipher.getAuthTag(),
    data,
  ]);
}

/** Opens a sealed private key with the releaser's key. Throws for anything that is not exactly that. */
export function unwrapPrivateKey(wrapped: Buffer, kek: string, context: WrapContext): Buffer {
  const headerBytes = 1 + X25519_BYTES + GCM_IV_BYTES + GCM_TAG_BYTES;
  if (wrapped.length <= headerBytes || wrapped[0] !== FORMAT_VERSION) {
    throw new Error('not a sealed archive key');
  }
  const privateRaw = fromBase64(kek, 'The releaser key');
  const ephemeralPublic = wrapped.subarray(1, 1 + X25519_BYTES);
  const iv = wrapped.subarray(1 + X25519_BYTES, 1 + X25519_BYTES + GCM_IV_BYTES);
  const tag = wrapped.subarray(1 + X25519_BYTES + GCM_IV_BYTES, headerBytes);
  const shared = diffieHellman({
    privateKey: x25519Private(privateRaw),
    publicKey: x25519Public(ephemeralPublic),
  });
  const decipher = createDecipheriv(
    'aes-256-gcm',
    wrapKey(shared, ephemeralPublic, rawPublicOf(privateRaw)),
    iv,
  );
  decipher.setAAD(wrapAad(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(wrapped.subarray(headerBytes)), decipher.final()]);
}

export interface ObjectContext {
  tenantId: string;
  /** The name of the object in the archive: an object moved to another name opens nothing. */
  name: string;
  keyVersion: number;
}

const objectAad = (context: ObjectContext) =>
  Buffer.from(
    `archive-object|v1|${context.tenantId}|${context.name}|${String(context.keyVersion)}`,
  );

/**
 * Encrypts one object for the archive with the PUBLIC key of its organization. Layout: "ARCH" (4) |
 * version (1) | key version (4) | length of the wrapped data key (2) | wrapped data key | nonce (12) |
 * tag (16) | ciphertext.
 */
export function sealObject(plain: Buffer, tenantPublicKey: Buffer, context: ObjectContext): Buffer {
  const dataKey = randomBytes(32);
  const wrappedKey = publicEncrypt(
    {
      key: createPublicKey({ key: tenantPublicKey, format: 'der', type: 'spki' }),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    dataKey,
  );
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(objectAad(context));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);

  const header = Buffer.alloc(OBJECT_MAGIC.length + 1 + 4 + 2);
  OBJECT_MAGIC.copy(header, 0);
  header.writeUInt8(FORMAT_VERSION, OBJECT_MAGIC.length);
  header.writeUInt32BE(context.keyVersion, OBJECT_MAGIC.length + 1);
  header.writeUInt16BE(wrappedKey.length, OBJECT_MAGIC.length + 5);
  return Buffer.concat([header, wrappedKey, iv, cipher.getAuthTag(), data]);
}

/** Decrypts an archived object with the PRIVATE key of its organization. Throws for any alteration. */
export function openObject(
  sealed: Buffer,
  tenantPrivateKey: Buffer,
  context: ObjectContext,
): Buffer {
  const fixed = OBJECT_MAGIC.length + 1 + 4 + 2;
  if (sealed.length < fixed || !sealed.subarray(0, OBJECT_MAGIC.length).equals(OBJECT_MAGIC)) {
    throw new Error('not an archived object');
  }
  if (sealed.readUInt8(OBJECT_MAGIC.length) !== FORMAT_VERSION) {
    throw new Error('unsupported archive format');
  }
  if (sealed.readUInt32BE(OBJECT_MAGIC.length + 1) !== context.keyVersion) {
    throw new Error('the object was sealed with another key version');
  }
  const wrappedLength = sealed.readUInt16BE(OBJECT_MAGIC.length + 5);
  const bodyAt = fixed + wrappedLength;
  if (sealed.length < bodyAt + GCM_IV_BYTES + GCM_TAG_BYTES)
    throw new Error('truncated archived object');

  const dataKey = privateDecrypt(
    {
      key: createPrivateKey({ key: tenantPrivateKey, format: 'der', type: 'pkcs8' }),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    sealed.subarray(fixed, bodyAt),
  );
  const iv = sealed.subarray(bodyAt, bodyAt + GCM_IV_BYTES);
  const tag = sealed.subarray(bodyAt + GCM_IV_BYTES, bodyAt + GCM_IV_BYTES + GCM_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', dataKey, iv);
  decipher.setAAD(objectAad(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(sealed.subarray(bodyAt + GCM_IV_BYTES + GCM_TAG_BYTES)),
    decipher.final(),
  ]);
}
