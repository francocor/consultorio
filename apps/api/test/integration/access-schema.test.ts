import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { membershipLocation, permissionGrant } from '../../src/db/schema/access.js';
import { location } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser, type TestUser } from '../support/users.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;
let member: TestUser;
let admin: TestUser;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'access-schema-a' });
  b = await createTestTenant(runtime, { slug: 'access-schema-b' });
  member = await createTestUser(runtime, a.id, { roles: ['reception'] });
  admin = await createTestUser(runtime, a.id, { roles: ['admin'] });
});

afterAll(async () => {
  await runtime.close();
});

const grantRow = (permission: string) => ({
  tenantId: a.id,
  membershipId: member.membershipId,
  permission,
  grantedBy: admin.id,
});

describe('permission_grant', () => {
  it('stores a non-clinical grant with its scope', async () => {
    const [row] = await asTenant(runtime, a.id, (tx) =>
      tx
        .insert(permissionGrant)
        .values({ ...grantRow('scheduling.delegated_calendar'), scope: { professionalIds: ['x'] } })
        .returning(),
    );

    expect(row).toMatchObject({
      permission: 'scheduling.delegated_calendar',
      scope: { professionalIds: ['x'] },
      revokedAt: null,
    });
  });

  it.each(['clinical.note.read', 'clinical.anamnesis.write', 'clinical.x'])(
    'refuses %s at the database, whatever the application does',
    async (permission) => {
      await expect(
        asTenant(runtime, a.id, (tx) => tx.insert(permissionGrant).values(grantRow(permission))),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    },
  );

  it('allows one live grant per member and permission, and a new one after a revocation', async () => {
    await asTenant(runtime, a.id, (tx) =>
      tx.insert(permissionGrant).values(grantRow('cash.operate')),
    );

    await expect(
      asTenant(runtime, a.id, (tx) => tx.insert(permissionGrant).values(grantRow('cash.operate'))),
    ).rejects.toMatchObject({ cause: { code: '23505' } });

    await asTenant(runtime, a.id, (tx) =>
      tx
        .update(permissionGrant)
        .set({ revokedAt: new Date(), revokedBy: admin.id })
        .where(eq(permissionGrant.permission, 'cash.operate')),
    );
    await asTenant(runtime, a.id, (tx) =>
      tx.insert(permissionGrant).values(grantRow('cash.operate')),
    );
  });

  it("cannot point at another organization's membership", async () => {
    await expect(
      asTenant(runtime, b.id, (tx) =>
        tx.insert(permissionGrant).values({
          tenantId: b.id,
          membershipId: member.membershipId,
          permission: 'cash.operate',
          grantedBy: admin.id,
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });
});

describe('membership_location', () => {
  it('assigns a member to a location once while the assignment is live', async () => {
    const [place] = await asTenant(runtime, a.id, (tx) =>
      tx
        .insert(location)
        .values({ tenantId: a.id, name: 'Centro', timeZone: 'America/Argentina/Buenos_Aires' })
        .returning({ id: location.id }),
    );
    const values = {
      tenantId: a.id,
      membershipId: member.membershipId,
      locationId: place?.id ?? '',
    };
    await asTenant(runtime, a.id, (tx) => tx.insert(membershipLocation).values(values));

    await expect(
      asTenant(runtime, a.id, (tx) => tx.insert(membershipLocation).values(values)),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it("cannot point at another organization's location", async () => {
    const [foreign] = await asTenant(runtime, b.id, (tx) =>
      tx
        .insert(location)
        .values({ tenantId: b.id, name: 'Norte', timeZone: 'America/Argentina/Buenos_Aires' })
        .returning({ id: location.id }),
    );

    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.insert(membershipLocation).values({
          tenantId: a.id,
          membershipId: member.membershipId,
          locationId: foreign?.id ?? '',
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });
});
