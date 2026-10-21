import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { archiveKey } from '../../src/db/schema/archive-key.js';
import {
  generateReleaserKeys,
  generateTenantKeyPair,
  unwrapPrivateKey,
  type TenantKeyPair,
} from '../../src/modules/tenancy/archive/archive-crypto.js';
import { createArchiveKeyWriter } from '../../src/modules/tenancy/archive/keys.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { SYSTEM_USER_ID, createWithTenant } from '../../src/platform/db/tenant-context.js';
import { createTestTenant } from '../support/tenants.js';

/**
 * The writer of the archive seals the private half of the key of an organization to the releaser and
 * must not keep a readable copy (JD-S6 R1-A-T8): the buffer it generated is overwritten once it was
 * sealed, and what was sealed still opens with the key of the releaser.
 */
let runtime: DbHandle;

beforeAll(() => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
});

afterAll(async () => {
  await runtime.close();
});

describe('the key writer of the archive', () => {
  it('overwrites the private key it generated once it was sealed to the releaser', async () => {
    const tenant = await createTestTenant(runtime, { slug: 'archive-key-hygiene' });
    const releaser = generateReleaserKeys();
    const withTenant = createWithTenant(runtime.db);
    let generated: TenantKeyPair | undefined;
    let original: Buffer | undefined;
    const writer = createArchiveKeyWriter({
      withTenant,
      releaserPublicKey: releaser.publicKey,
      generate: async () => {
        generated = await generateTenantKeyPair();
        original = Buffer.from(generated.privateKey);
        return generated;
      },
    });

    const key = await writer.current({ tenantId: tenant.id, userId: SYSTEM_USER_ID });

    expect(generated?.privateKey.length).toBeGreaterThan(100);
    expect(generated?.privateKey.every((byte) => byte === 0)).toBe(true);
    expect(key.version).toBe(1);
    // What was sealed is intact: the releaser still opens it, and it is the key that was generated.
    const [stored] = await withTenant({ tenantId: tenant.id, userId: SYSTEM_USER_ID }, (tx) =>
      tx.select().from(archiveKey),
    );
    expect(stored).toBeDefined();
    const opened = unwrapPrivateKey(stored?.wrappedPrivateKey ?? Buffer.alloc(0), releaser.kek, {
      tenantId: tenant.id,
      version: 1,
    });
    expect(original?.length).toBeGreaterThan(100);
    expect(opened.equals(original ?? Buffer.alloc(0))).toBe(true);
  });
});
