import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { exportStaff } from '../../src/modules/identity/application/export-contributor.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'export-staff-a' });
  b = await createTestTenant(runtime, { slug: 'export-staff-b' });
});

afterAll(async () => {
  await runtime.close();
});

describe('administrative export of the staff', () => {
  it('lists the staff of the exporting organization with roles and status, and nobody else', async () => {
    await createTestUser(runtime, a.id, {
      email: 'owner@export-a.example',
      roles: ['owner', 'professional'],
    });
    await createTestUser(runtime, a.id, {
      email: 'desk@export-a.example',
      roles: ['reception'],
      status: 'deactivated',
    });
    await createTestUser(runtime, b.id, { email: 'someone@export-b.example' });

    const part = await asTenant(runtime, a.id, (tx) => exportStaff({ tx, tenantId: a.id }));

    expect(part).toMatchObject({
      staff: [
        { email: 'desk@export-a.example', roles: ['reception'], status: 'deactivated' },
        { email: 'owner@export-a.example', roles: ['owner', 'professional'], status: 'active' },
      ],
    });
  });

  it('never includes password hashes, second-factor secrets or recovery codes', async () => {
    const part = await asTenant(runtime, a.id, (tx) => exportStaff({ tx, tenantId: a.id }));

    const text = JSON.stringify(part);
    expect(text).not.toMatch(/argon2|password|totp|recovery|hash/i);
  });
});
