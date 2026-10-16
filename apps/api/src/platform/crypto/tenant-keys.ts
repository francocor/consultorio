import { and, desc, eq, sql } from 'drizzle-orm';

import { tenantKey } from '../../db/schema/tenant-key.js';
import type { Tx } from '../db/tenant-context.js';

import { decrypt, encrypt, readKeyVersion, type Aad } from './aes-gcm.js';
import { KeyManagementError, type KeyManagement } from './key-management.js';

const PURPOSE = 'tenant-dek' as const;
const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 1000;

/** Where an encrypted value lives; it is authenticated together with the tenant (AAD). */
export interface FieldRef {
  table: string;
  column: string;
  rowId: string;
}

export interface TenantKeysOptions {
  kms: KeyManagement;
  /** How long an unwrapped key stays in memory. Defaults to 5 minutes. */
  ttlMs?: number;
  /** Most keys held at once; the oldest is dropped (and zeroed) beyond it. Defaults to 1000. */
  maxEntries?: number;
  now?: () => number;
}

export interface TenantKeys {
  /**
   * Creates the tenant's first data key if it has none. Called when the tenant is created, and
   * safe to call again: the one-active-key unique index makes it idempotent and race-free.
   */
  ensureTenantKey(tx: Tx): Promise<{ version: number; created: boolean }>;
  /** Retires the active key and activates a new version. Old data stays readable. */
  rotateTenantKey(tx: Tx): Promise<{ version: number }>;
  encryptField(tx: Tx, ref: FieldRef, plaintext: Buffer | string): Promise<Buffer>;
  decryptField(tx: Tx, ref: FieldRef, blob: Buffer): Promise<Buffer>;
}

interface CachedKey {
  key: Buffer;
  expiresAt: number;
}

/**
 * Envelope encryption for tenant fields (design, "Encryption and secrets"). Each tenant has its
 * own data key (DEK), stored wrapped by the key service. A DEK is unwrapped on demand and kept in
 * memory for a short time, then zeroed. A ciphertext carries the version of the key that made it,
 * so keys can rotate without re-encrypting history.
 *
 * The tenant is always the one of the transaction (`app.tenant_id`), never a parameter, so code
 * cannot ask for another tenant's key by mistake. Row level security also hides other tenants'
 * wrapped keys, and the tenant id is part of the AAD and of the KMS encryption context.
 */
export function createTenantKeys(options: TenantKeysOptions): TenantKeys {
  const { kms } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;

  const keys = new Map<string, CachedKey>();
  const activeVersions = new Map<string, { version: number; expiresAt: number }>();
  const tenants = new WeakMap<Tx, string>();

  /** The tenant of this transaction, asked once per transaction. */
  const tenantOf = async (tx: Tx): Promise<string> => {
    const known = tenants.get(tx);
    if (known) return known;
    const result = await tx.execute<{ tenant: string | null }>(
      sql`select nullif(current_setting('app.tenant_id', true), '') as tenant`,
    );
    const tenant = result.rows[0]?.tenant;
    if (!tenant) throw new KeyManagementError();
    tenants.set(tx, tenant);
    return tenant;
  };

  const keyId = (tenantId: string, version: number) => `${tenantId}:${String(version)}`;

  const forget = (id: string) => {
    keys.get(id)?.key.fill(0);
    keys.delete(id);
  };

  const remember = (tenantId: string, version: number, key: Buffer) => {
    const id = keyId(tenantId, version);
    forget(id);
    keys.set(id, { key, expiresAt: now() + ttlMs });
    while (keys.size > maxEntries) {
      const oldest = keys.keys().next().value;
      if (oldest === undefined) break;
      forget(oldest);
    }
  };

  const cached = (tenantId: string, version: number): Buffer | undefined => {
    const id = keyId(tenantId, version);
    const entry = keys.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      forget(id);
      return undefined;
    }
    return entry.key;
  };

  const activeVersion = async (tx: Tx, tenantId: string): Promise<number | undefined> => {
    const known = activeVersions.get(tenantId);
    if (known && known.expiresAt > now()) return known.version;
    const [row] = await tx
      .select({ version: tenantKey.version })
      .from(tenantKey)
      .where(
        and(
          eq(tenantKey.tenantId, tenantId),
          eq(tenantKey.purpose, PURPOSE),
          eq(tenantKey.status, 'active'),
        ),
      );
    if (!row) return undefined;
    activeVersions.set(tenantId, { version: row.version, expiresAt: now() + ttlMs });
    return row.version;
  };

  /** The unwrapped key of a given version, from memory or from its wrapped form in the database. */
  const keyFor = async (tx: Tx, tenantId: string, version: number): Promise<Buffer> => {
    const hit = cached(tenantId, version);
    if (hit) return hit;

    const [row] = await tx
      .select({ dekWrapped: tenantKey.dekWrapped })
      .from(tenantKey)
      .where(
        and(
          eq(tenantKey.tenantId, tenantId),
          eq(tenantKey.purpose, PURPOSE),
          eq(tenantKey.version, version),
        ),
      );
    if (!row) throw new KeyManagementError();

    const key = await kms.unwrapDataKey(row.dekWrapped, { tenantId, purpose: PURPOSE });
    remember(tenantId, version, key);
    return key;
  };

  const ensureFor = async (tx: Tx, tenantId: string) => {
    const existing = await activeVersion(tx, tenantId);
    if (existing !== undefined) return { version: existing, created: false };

    const generated = await kms.generateDataKey({ tenantId, purpose: PURPOSE });
    const inserted = await tx
      .insert(tenantKey)
      .values({
        tenantId,
        purpose: PURPOSE,
        version: 1,
        kekId: generated.kekId,
        dekWrapped: generated.wrapped,
        status: 'active',
      })
      .onConflictDoNothing()
      .returning({ version: tenantKey.version });

    if (inserted.length === 0) {
      // Another transaction created it first: use theirs and discard ours.
      generated.plaintext.fill(0);
      const winner = await activeVersion(tx, tenantId);
      if (winner === undefined) throw new KeyManagementError();
      return { version: winner, created: false };
    }
    remember(tenantId, 1, generated.plaintext);
    activeVersions.set(tenantId, { version: 1, expiresAt: now() + ttlMs });
    return { version: 1, created: true };
  };

  const rotateFor = async (tx: Tx, tenantId: string) => {
    const [latest] = await tx
      .select({ version: tenantKey.version })
      .from(tenantKey)
      .where(and(eq(tenantKey.tenantId, tenantId), eq(tenantKey.purpose, PURPOSE)))
      .orderBy(desc(tenantKey.version))
      .limit(1);
    const next = (latest?.version ?? 0) + 1;

    const generated = await kms.generateDataKey({ tenantId, purpose: PURPOSE });
    await tx
      .update(tenantKey)
      .set({ status: 'retired' })
      .where(
        and(
          eq(tenantKey.tenantId, tenantId),
          eq(tenantKey.purpose, PURPOSE),
          eq(tenantKey.status, 'active'),
        ),
      );
    await tx.insert(tenantKey).values({
      tenantId,
      purpose: PURPOSE,
      version: next,
      kekId: generated.kekId,
      dekWrapped: generated.wrapped,
      status: 'active',
    });
    remember(tenantId, next, generated.plaintext);
    activeVersions.set(tenantId, { version: next, expiresAt: now() + ttlMs });
    return { version: next };
  };

  const aad = (tenantId: string, ref: FieldRef): Aad => ({ tenantId, ...ref });

  return {
    async ensureTenantKey(tx) {
      return ensureFor(tx, await tenantOf(tx));
    },

    async rotateTenantKey(tx) {
      return rotateFor(tx, await tenantOf(tx));
    },

    async encryptField(tx, ref, plaintext) {
      const tenantId = await tenantOf(tx);
      const version =
        (await activeVersion(tx, tenantId)) ?? (await ensureFor(tx, tenantId)).version;
      const key = await keyFor(tx, tenantId, version);
      return encrypt(key, plaintext, aad(tenantId, ref), version);
    },

    async decryptField(tx, ref, blob) {
      const tenantId = await tenantOf(tx);
      const key = await keyFor(tx, tenantId, readKeyVersion(blob));
      return decrypt(key, blob, aad(tenantId, ref));
    },
  };
}
