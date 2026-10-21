import { createHash } from 'node:crypto';

import { desc, eq } from 'drizzle-orm';

import { archiveKey } from '../../../db/schema/archive-key.js';
import type { RequestContext, Tx, WithTenant } from '../../../platform/db/tenant-context.js';

import {
  generateTenantKeyPair,
  unwrapPrivateKey,
  wrapPrivateKey,
  type TenantKeyPair,
} from './archive-crypto.js';

/**
 * The archive key pairs of the organizations, in two halves that never meet in one process.
 *
 * - **The writer** (the API and the worker) creates the key pair of an organization on first use,
 *   seals the private half to the releaser (`wrapPrivateKey`, which needs only the PUBLIC key of the
 *   releaser) and forgets it. From then on it knows the public half, which is all that writing the
 *   archive takes. It holds nothing with which to read one object back: there is no function here
 *   that opens a private key without the key of the releaser.
 * - **The releaser** holds `ARCHIVE_RELEASER_KEK`, opens the private half of an organization when an
 *   approved release or a restore needs it, and holds it in memory only for that.
 *
 * A version of a key is never changed or deleted (the runtime role has no UPDATE or DELETE on the
 * table); a rotation would add a version, and an archived object names the version it was sealed with.
 */

export interface ArchivePublicKey {
  version: number;
  /** SPKI DER. */
  publicKey: Buffer;
}

export interface ArchiveKeyWriter {
  /** The current key of an organization, made (and its private half sealed to the releaser) if none exists. */
  current(context: RequestContext): Promise<ArchivePublicKey>;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function latest(tx: Tx): Promise<ArchivePublicKey | null> {
  const [row] = await tx
    .select({ version: archiveKey.version, publicKey: archiveKey.publicKey })
    .from(archiveKey)
    .orderBy(desc(archiveKey.version))
    .limit(1);
  return row ?? null;
}

export function createArchiveKeyWriter(deps: {
  withTenant: WithTenant;
  /** The public half of the key of the releaser (32 bytes, base64). */
  releaserPublicKey: string;
  /** Makes a key pair; replaceable in tests. */
  generate?: () => Promise<TenantKeyPair>;
}): ArchiveKeyWriter {
  return {
    async current(context) {
      const known = await deps.withTenant(context, latest);
      if (known) return known;

      // Generating 3072 bits takes a moment: it is done with no transaction open.
      const pair: TenantKeyPair = await (deps.generate ?? generateTenantKeyPair)();
      const version = 1;
      let wrapped: Buffer;
      try {
        wrapped = wrapPrivateKey(pair.privateKey, deps.releaserPublicKey, {
          tenantId: context.tenantId,
          version,
        });
      } finally {
        // The writer must not be able to read the archive back: once the private half is sealed to
        // the releaser, the plain copy in this process's memory is overwritten (JD-S6 R1-A-T8).
        pair.privateKey.fill(0);
      }
      return deps.withTenant(context, async (tx) => {
        await tx
          .insert(archiveKey)
          .values({
            tenantId: context.tenantId,
            version,
            publicKey: pair.publicKey,
            publicKeySha256: sha256(pair.publicKey),
            wrappedPrivateKey: wrapped,
          })
          .onConflictDoNothing();
        // A concurrent writer may have made the first version: whichever won is THE key.
        const winner = await latest(tx);
        if (!winner) throw new Error('the archive key was not stored');
        return winner;
      });
    },
  };
}

export interface ArchiveKeyReleaser {
  /** The private half of one version of the key of the organization of the transaction. */
  privateKey(tx: Tx, tenantId: string, version: number): Promise<Buffer>;
}

export function createArchiveKeyReleaser(deps: { kek: string }): ArchiveKeyReleaser {
  return {
    async privateKey(tx, tenantId, version) {
      const [row] = await tx.select().from(archiveKey).where(eq(archiveKey.version, version));
      if (!row) throw new Error('the organization has no archive key of that version');
      const privateKey = unwrapPrivateKey(row.wrappedPrivateKey, deps.kek, { tenantId, version });
      // The key opened must be the one whose public half the objects were sealed to.
      if (sha256(row.publicKey) !== row.publicKeySha256) {
        throw new Error('the archive key does not match its checksum');
      }
      return privateKey;
    },
  };
}
