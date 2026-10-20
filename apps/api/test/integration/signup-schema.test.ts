import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { tenant } from '../../src/db/schema/tenant.js';
import { createTenantLookup } from '../../src/modules/tenancy/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';
import { listTenantIds } from '../../src/platform/jobs/tenant-scan.js';
import { buildTestApplication, browserHeaders } from '../support/app.js';
import { asTenant, createTestTenant, TEST_USER } from '../support/tenants.js';

/**
 * The database side of the signup (S6.02, task 6.9): the `unverified` state of an organization, the
 * versions of the terms, the acceptance record, the pending signup and what the runtime role can
 * and cannot do with them. The generated isolation suite covers `signup_pending` and
 * `terms_acceptance` with the fixtures of `fixtures/signup.ts`.
 */
let runtime: DbHandle;
let owner: pg.Client;
let operator: pg.Client;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  operator = new pg.Client({ connectionString: inject('operatorUrl') });
  await operator.connect();
});

afterAll(async () => {
  await operator.end();
  await owner.end();
  await runtime.close();
});

const NO_TENANT = '00000000-0000-0000-0000-000000000000';

/** Runs statements on a raw connection inside a transaction that carries a tenant context. */
async function inTransaction<T>(
  client: pg.Client,
  tenantId: string,
  work: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    return await work();
  } finally {
    await client.query('ROLLBACK');
  }
}

async function unverifiedTenant(slug: string) {
  return createTestTenant(runtime, { slug, status: 'unverified' });
}

describe('an organization nobody confirmed yet', () => {
  it('is a state the tenant table accepts, and the host lookup reports it as such', async () => {
    const created = await unverifiedTenant('sin-confirmar');

    const found = await createTenantLookup(runtime.db)('sin-confirmar');

    expect(found).toMatchObject({ id: created.id, slug: 'sin-confirmar', status: 'unverified' });
  });

  it('still refuses a status that does not exist', async () => {
    await expect(
      createTestTenant(runtime, { slug: 'otro-estado', status: 'pending' }),
    ).rejects.toThrow();
  });

  it('is left out of the scan that fans the per-organization jobs out', async () => {
    const waiting = await unverifiedTenant('fuera-del-escaneo');
    const active = await createTestTenant(runtime, { slug: 'dentro-del-escaneo' });

    const ids = await listTenantIds(runtime.db);

    expect(ids).toContain(active.id);
    expect(ids).not.toContain(waiting.id);
  });

  it('is not listed by the operator console, which has no business with a person who has not proved an address', async () => {
    const waiting = await unverifiedTenant('oculta-al-operador');
    const active = await createTestTenant(runtime, { slug: 'visible-al-operador' });

    const seen = await inTransaction(operator, NO_TENANT, () =>
      operator.query<{ id: string }>('SELECT id FROM tenant'),
    );

    expect(seen.rows.map((row) => row.id)).toContain(active.id);
    expect(seen.rows.map((row) => row.id)).not.toContain(waiting.id);
  });

  it('answers only what its verification page needs, and nothing else, whatever the route', async () => {
    await unverifiedTenant('solo-confirma');
    const app = buildTestApplication(runtime);
    try {
      const boot = await app.inject({
        method: 'GET',
        url: '/public/boot',
        headers: browserHeaders('solo-confirma'),
      });
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: browserHeaders('solo-confirma'),
        payload: { email: 'alguien@example.test', password: 'una contraseña larga' },
      });
      const booking = await app.inject({
        method: 'GET',
        url: '/public/solo-confirma/booking',
        headers: browserHeaders('solo-confirma'),
      });

      expect(boot.statusCode).toBe(200);
      expect(login.statusCode).toBe(404);
      expect(booking.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('the terms a signup asks for', () => {
  it('has one current version of each document, readable by the runtime role', async () => {
    const rows = await asTenant(runtime, uuidv7(), (tx) =>
      tx.execute<{ kind: string; version: number }>(
        sql`SELECT kind, version FROM terms_version WHERE is_current ORDER BY kind`,
      ),
    );

    expect(rows.rows).toEqual([
      { kind: 'data_processing', version: 1 },
      { kind: 'terms', version: 1 },
    ]);
  });

  it('cannot be written by the runtime role: publishing a version is a data change of the owner', async () => {
    const attempt = (statement: ReturnType<typeof sql>) =>
      asTenant(runtime, uuidv7(), (tx) => tx.execute(statement));

    await expect(
      attempt(sql`INSERT INTO terms_version (kind, version) VALUES ('terms', 2)`),
    ).rejects.toThrow();
    await expect(attempt(sql`UPDATE terms_version SET is_current = false`)).rejects.toThrow();
  });

  it('keeps one current version per kind', async () => {
    await expect(
      owner.query(
        `INSERT INTO terms_version (kind, version, is_current) VALUES ('terms', 2, true)`,
      ),
    ).rejects.toThrow(/terms_version_current_key/);
    await expect(
      owner.query(`INSERT INTO terms_version (kind, version) VALUES ('privacy', 1)`),
    ).rejects.toThrow(/terms_version_kind_check/);
  });
});

describe('the pending signup and the acceptance record', () => {
  const pending = (tenantId: string, email: string, hash: string | null = '$argon2id$x') =>
    sql`INSERT INTO signup_pending
          (tenant_id, owner_email, owner_name, password_hash, terms_version,
           data_processing_version, accepted_at, verified_at)
          VALUES (${tenantId}, ${email}, 'Ana Pérez', ${hash}, 1, 1, now(),
                  ${hash === null ? sql`now()` : sql`null`})`;

  it('lets an address wait for one link at a time, whatever its case', async () => {
    const first = await unverifiedTenant('espera-uno');
    const second = await unverifiedTenant('espera-dos');
    await asTenant(runtime, first.id, (tx) => tx.execute(pending(first.id, 'Ana@Example.test')));

    await expect(
      asTenant(runtime, second.id, (tx) => tx.execute(pending(second.id, 'ana@example.test'))),
    ).rejects.toThrow();
  });

  it('keeps the password hash exactly as long as the signup is unverified', async () => {
    const tenantA = await unverifiedTenant('hash-uno');
    const tenantB = await unverifiedTenant('hash-dos');

    await expect(
      asTenant(runtime, tenantA.id, (tx) =>
        tx.execute(
          sql`INSERT INTO signup_pending (tenant_id, owner_email, owner_name, password_hash,
                terms_version, data_processing_version, accepted_at)
              VALUES (${tenantA.id}, 'sin-hash@example.test', 'Ana', null, 1, 1, now())`,
        ),
      ),
    ).rejects.toThrow();
    // Verified, with no hash: allowed. Verified with a hash: refused.
    await asTenant(runtime, tenantB.id, (tx) =>
      tx.execute(pending(tenantB.id, 'confirmada@example.test', null)),
    );
    await expect(
      inTransaction(owner, tenantB.id, () =>
        owner.query(`UPDATE signup_pending SET password_hash = 'x' WHERE verified_at IS NOT NULL`),
      ),
    ).rejects.toThrow(/signup_pending_hash_check/);
  });

  it('is never deleted by the runtime role', async () => {
    const created = await unverifiedTenant('no-se-borra');
    await asTenant(runtime, created.id, (tx) => tx.execute(pending(created.id, 'x@example.test')));

    await expect(
      asTenant(runtime, created.id, (tx) =>
        tx.execute(sql`DELETE FROM signup_pending WHERE tenant_id = ${created.id}`),
      ),
    ).rejects.toThrow();
  });

  it('records an acceptance once and never lets it be edited or removed', async () => {
    const created = await createTestTenant(runtime, { slug: 'acepto' });
    const userId = uuidv7();
    await createWithTenant(runtime.db)({ tenantId: created.id, userId }, async (tx) => {
      await tx.execute(
        sql`INSERT INTO user_account (id, email, password_hash) VALUES (${userId}, 'acepta@example.test', 'h')`,
      );
      await tx.execute(
        sql`INSERT INTO terms_acceptance
              (tenant_id, user_id, terms_version, data_processing_version, accepted_at)
              VALUES (${created.id}, ${userId}, 2, 3, now())`,
      );
    });

    const edit = createWithTenant(runtime.db)({ tenantId: created.id, userId }, (tx) =>
      tx.execute(sql`UPDATE terms_acceptance SET terms_version = 1`),
    );
    const remove = createWithTenant(runtime.db)({ tenantId: created.id, userId }, (tx) =>
      tx.execute(sql`DELETE FROM terms_acceptance`),
    );
    await expect(edit).rejects.toThrow();
    await expect(remove).rejects.toThrow();
    const kept = await asTenant(runtime, created.id, (tx) =>
      tx.execute<{ terms_version: number; data_processing_version: number }>(
        sql`SELECT terms_version, data_processing_version FROM terms_acceptance`,
      ),
    );
    expect(kept.rows).toEqual([{ terms_version: 2, data_processing_version: 3 }]);
  });
});

describe('what an address is for the signup (app.signup_email_state)', () => {
  it('tells an account, a signup waiting for its link and a free address apart, by id and nothing else', async () => {
    const waiting = await unverifiedTenant('estado-espera');
    await asTenant(runtime, waiting.id, (tx) =>
      tx.execute(
        sql`INSERT INTO signup_pending (tenant_id, owner_email, owner_name, password_hash,
              terms_version, data_processing_version, accepted_at)
            VALUES (${waiting.id}, 'espera@example.test', 'Ana', '$argon2id$x', 1, 1, now())`,
      ),
    );
    const userId = uuidv7();
    await createWithTenant(runtime.db)({ tenantId: waiting.id, userId }, (tx) =>
      tx.execute(
        sql`INSERT INTO user_account (id, email, password_hash) VALUES (${userId}, 'cuenta@example.test', 'h')`,
      ),
    );
    const state = (email: string) =>
      asTenant(runtime, uuidv7(), async (tx) => {
        const result = await tx.execute<{ state: string; tenant_id: string | null }>(
          sql`SELECT state, tenant_id FROM app.signup_email_state(${email})`,
        );
        return result.rows;
      });

    expect(await state('CUENTA@example.test')).toEqual([{ state: 'account', tenant_id: null }]);
    expect(await state('espera@example.test')).toEqual([
      { state: 'pending', tenant_id: waiting.id },
    ]);
    expect(await state('libre@example.test')).toEqual([]);
  });
});

describe('the status of an organization', () => {
  it('moves from unverified to active in one update, which the runtime role may do', async () => {
    const created = await unverifiedTenant('se-activa');

    await asTenant(runtime, created.id, (tx) =>
      tx.update(tenant).set({ status: 'active' }).where(eq(tenant.id, created.id)),
    );

    const [row] = await asTenant(runtime, created.id, (tx) =>
      tx.select({ status: tenant.status }).from(tenant).where(eq(tenant.id, created.id)),
    );
    expect(row?.status).toBe('active');
    expect(TEST_USER).toBeDefined();
  });
});
