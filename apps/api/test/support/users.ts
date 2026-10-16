import { randomUUID } from 'node:crypto';

import type { Role } from '@consultorio/contracts';

import { membership, userAccount } from '../../src/db/schema/identity.js';
import { createPasswordHasher } from '../../src/modules/identity/infrastructure/argon2.js';
import type { DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';

export interface TestUser {
  id: string;
  email: string;
  membershipId: string;
}

let counter = 0;

/** Placeholder hash for tests that never verify a password. */
export const FAKE_PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$ZmFrZXNhbHQ$ZmFrZWhhc2g';

const hasher = createPasswordHasher();
const hashes = new Map<string, Promise<string>>();

/** Argon2 hash of a test password, computed once per distinct password. */
export function hashForTest(password: string): Promise<string> {
  let hash = hashes.get(password);
  if (!hash) {
    hash = hasher.hash(password);
    hashes.set(password, hash);
  }
  return hash;
}

/**
 * Creates a staff user with an active membership in a tenant, the way the invitation flow does:
 * the transaction acts AS the new user (`app.user_id`), which is the only way the `user_account`
 * policy lets a row be inserted.
 */
export async function createTestUser(
  handle: DbHandle,
  tenantId: string,
  options: {
    email?: string;
    roles?: readonly Role[];
    passwordHash?: string;
    /** Plain password; hashed with Argon2id (cached across tests). */
    password?: string;
    status?: 'active' | 'deactivated';
    firstSignInAt?: Date | null;
  } = {},
): Promise<TestUser> {
  counter += 1;
  const id = uuidv7();
  const membershipId = uuidv7();
  const email = options.email ?? `user-${String(counter)}-${randomUUID().slice(0, 8)}@example.test`;
  await createWithTenant(handle.db)({ tenantId, userId: id }, async (tx) => {
    await tx.insert(userAccount).values({
      id,
      email,
      passwordHash:
        options.passwordHash ??
        (options.password === undefined ? FAKE_PASSWORD_HASH : await hashForTest(options.password)),
      firstSignInAt: options.firstSignInAt ?? null,
    });
    await tx.insert(membership).values({
      id: membershipId,
      tenantId,
      userId: id,
      roles: [...(options.roles ?? ['reception'])],
      status: options.status ?? 'active',
    });
  });
  return { id, email, membershipId };
}

/** Links an existing user to another tenant (a user may work in several organizations). */
export async function addTestMembership(
  handle: DbHandle,
  tenantId: string,
  userId: string,
  roles: readonly Role[] = ['reception'],
): Promise<string> {
  const membershipId = uuidv7();
  await createWithTenant(handle.db)({ tenantId, userId }, (tx) =>
    tx.insert(membership).values({ id: membershipId, tenantId, userId, roles: [...roles] }),
  );
  return membershipId;
}
