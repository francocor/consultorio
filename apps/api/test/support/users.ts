import { randomUUID } from 'node:crypto';

import type { Role } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';

import { membership, userAccount } from '../../src/db/schema/identity.js';
import { professional } from '../../src/db/schema/staff.js';
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

/**
 * A health professional: a user with the professional role and a profile. The profile id can be
 * chosen, so a test that needs a known professional id gets a real row behind it (the care tables
 * point at the profile with a composite foreign key).
 */
export async function createTestProfessional(
  handle: DbHandle,
  tenantId: string,
  options: {
    id?: string;
    matricula?: string;
    jurisdiction?: string;
    specialties?: string[];
    /** Plain password, so the test can sign the professional in. */
    password?: string;
    /** Roles besides `professional`, for example an owner who is also the professional. */
    alsoRoles?: readonly Role[];
  } = {},
): Promise<TestUser & { professionalId: string }> {
  const user = await createTestUser(handle, tenantId, {
    roles: ['professional', ...(options.alsoRoles ?? [])],
    ...(options.password === undefined ? {} : { password: options.password }),
  });
  const professionalId = options.id ?? uuidv7();
  await createWithTenant(handle.db)({ tenantId, userId: user.id }, (tx) =>
    tx.insert(professional).values({
      id: professionalId,
      tenantId,
      membershipId: user.membershipId,
      matricula: options.matricula ?? String(100000 + counter),
      matriculaJurisdiction: options.jurisdiction ?? 'AR-B',
      specialties: options.specialties ?? ['general'],
    }),
  );
  return { ...user, professionalId };
}

/** Makes sure a professional profile with this id exists in the tenant (idempotent). */
export async function ensureTestProfessional(
  handle: DbHandle,
  tenantId: string,
  id: string,
): Promise<void> {
  const found = await createWithTenant(handle.db)({ tenantId, userId: uuidv7() }, (tx) =>
    tx.select({ id: professional.id }).from(professional).where(eq(professional.id, id)),
  );
  if (found.length === 0) await createTestProfessional(handle, tenantId, { id });
}
