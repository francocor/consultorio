import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { professional, professionalHours } from '../../src/db/schema/staff.js';
import { location } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let admin: pg.Client;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  a = await createTestTenant(runtime, { slug: 'staff-schema-a' });
  b = await createTestTenant(runtime, { slug: 'staff-schema-b' });
});

afterAll(async () => {
  await admin.end();
  await runtime.close();
});

async function makeProfessional(
  values: Partial<typeof professional.$inferInsert> = {},
  tenant = a,
): Promise<string> {
  const user = await createTestUser(runtime, tenant.id, { roles: ['professional'] });
  const [row] = await asTenant(runtime, tenant.id, (tx) =>
    tx
      .insert(professional)
      .values({
        tenantId: tenant.id,
        membershipId: user.membershipId,
        specialties: ['general'],
        ...values,
      })
      .returning({ id: professional.id }),
  );
  return row?.id ?? '';
}

/** Runs SQL as the platform operator: a role the application cannot become. */
async function asOperator(tenant: TestTenant, statement: string, values: unknown[] = []) {
  await admin.query('BEGIN');
  try {
    await admin.query('SET LOCAL ROLE app_operator');
    await admin.query(`select set_config('app.tenant_id', $1, true)`, [tenant.id]);
    return await admin.query(statement, values);
  } finally {
    await admin.query('COMMIT');
  }
}

async function rowOf(id: string, tenant = a) {
  const [row] = await asTenant(runtime, tenant.id, (tx) =>
    tx.select().from(professional).where(eq(professional.id, id)),
  );
  return row;
}

describe('a tenant user cannot verify a matricula', () => {
  it('starts every profile unverified', async () => {
    const id = await makeProfessional({ matricula: '12345', matriculaJurisdiction: 'AR-B' });

    expect(await rowOf(id)).toMatchObject({
      matriculaStatus: 'unverified',
      verifiedByOperator: null,
    });
  });

  it('refuses to insert a profile that is already verified', async () => {
    await expect(
      makeProfessional({
        matricula: '777',
        matriculaJurisdiction: 'AR-B',
        matriculaStatus: 'verified',
        verifiedByOperator: uuidv7(),
      }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('refuses to flip an existing profile to verified, with or without a verifier', async () => {
    const id = await makeProfessional({ matricula: '4321', matriculaJurisdiction: 'AR-B' });

    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx
          .update(professional)
          .set({ matriculaStatus: 'verified', verifiedByOperator: uuidv7() })
          .where(eq(professional.id, id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.update(professional).set({ matriculaStatus: 'verified' }).where(eq(professional.id, id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    expect(await rowOf(id)).toMatchObject({ matriculaStatus: 'unverified' });
  });

  it('refuses to forge the verifier or the date on an unverified profile', async () => {
    const id = await makeProfessional({ matricula: '5555', matriculaJurisdiction: 'AR-B' });

    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx
          .update(professional)
          .set({ verifiedByOperator: uuidv7(), verifiedAt: new Date() })
          .where(eq(professional.id, id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('lets the operator verify, and a tenant edit of the number puts it back to unverified', async () => {
    const id = await makeProfessional({ matricula: '9001', matriculaJurisdiction: 'AR-B' });
    const operator = uuidv7();

    await asOperator(
      a,
      `update professional set matricula_status = 'verified', verified_by_operator = $1, verified_at = now() where id = $2`,
      [operator, id],
    );
    expect(await rowOf(id)).toMatchObject({
      matriculaStatus: 'verified',
      verifiedByOperator: operator,
    });

    await asTenant(runtime, a.id, (tx) =>
      tx
        .update(professional)
        .set({ specialties: ['general', 'nutrition'] })
        .where(eq(professional.id, id)),
    );
    expect(await rowOf(id)).toMatchObject({ matriculaStatus: 'verified' });

    await asTenant(runtime, a.id, (tx) =>
      tx.update(professional).set({ matricula: '9002' }).where(eq(professional.id, id)),
    );
    expect(await rowOf(id)).toMatchObject({
      matricula: '9002',
      matriculaStatus: 'unverified',
      verifiedByOperator: null,
      verifiedAt: null,
    });
  });

  it('puts a verified profile back to unverified when the jurisdiction changes', async () => {
    const id = await makeProfessional({ matricula: '9100', matriculaJurisdiction: 'AR-B' });
    await asOperator(
      a,
      `update professional set matricula_status = 'verified', verified_by_operator = $1, verified_at = now() where id = $2`,
      [uuidv7(), id],
    );

    await asTenant(runtime, a.id, (tx) =>
      tx.update(professional).set({ matriculaJurisdiction: 'AR-X' }).where(eq(professional.id, id)),
    );

    expect(await rowOf(id)).toMatchObject({ matriculaStatus: 'unverified' });
  });

  it('gives the operator no power over anything but the three verification columns', async () => {
    const id = await makeProfessional({ matricula: '9200', matriculaJurisdiction: 'AR-B' });

    await expect(
      asOperator(a, `update professional set matricula = '1' where id = $1`, [id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asOperator(a, `update professional set status = 'inactive' where id = $1`, [id]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a verified row without a registration or a verifier', async () => {
    const id = await makeProfessional();

    await expect(
      asOperator(
        a,
        `update professional set matricula_status = 'verified', verified_by_operator = $1 where id = $2`,
        [uuidv7(), id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('matricula uniqueness', () => {
  it('rejects the same registration for two active professionals of one organization', async () => {
    await makeProfessional({ matricula: '31000', matriculaJurisdiction: 'AR-C' });

    await expect(
      makeProfessional({ matricula: '31000', matriculaJurisdiction: 'AR-C' }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('treats another jurisdiction as another registration', async () => {
    await makeProfessional({ matricula: '31001', matriculaJurisdiction: 'AR-C' });

    await makeProfessional({ matricula: '31001', matriculaJurisdiction: 'AR-X' });
  });

  it('lets an inactive professional keep a registration an active one now holds', async () => {
    await makeProfessional({
      matricula: '31002',
      matriculaJurisdiction: 'AR-C',
      status: 'inactive',
    });

    await makeProfessional({ matricula: '31002', matriculaJurisdiction: 'AR-C' });
  });

  it('is per organization: the same registration in another organization is fine', async () => {
    await makeProfessional({ matricula: '31003', matriculaJurisdiction: 'AR-C' });

    await makeProfessional({ matricula: '31003', matriculaJurisdiction: 'AR-C' }, b);
  });

  it('allows profiles without a registration, and refuses a half-recorded one', async () => {
    await makeProfessional();
    await makeProfessional();

    await expect(makeProfessional({ matricula: '1' })).rejects.toMatchObject({
      cause: { code: '23514' },
    });
  });

  it('is attached to a membership of its own organization', async () => {
    const stranger = await createTestUser(runtime, b.id, { roles: ['professional'] });

    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.insert(professional).values({
          tenantId: a.id,
          membershipId: stranger.membershipId,
          specialties: ['general'],
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });
});

describe('professional_hours', () => {
  async function place(tenant = a) {
    const [row] = await asTenant(runtime, tenant.id, (tx) =>
      tx
        .insert(location)
        .values({ tenantId: tenant.id, name: 'Centro', timeZone: 'America/Argentina/Buenos_Aires' })
        .returning({ id: location.id }),
    );
    return row?.id ?? '';
  }

  it('stores an interval of minutes at a location', async () => {
    const professionalId = await makeProfessional();
    const locationId = await place();

    const [row] = await asTenant(runtime, a.id, (tx) =>
      tx
        .insert(professionalHours)
        .values({
          tenantId: a.id,
          professionalId,
          locationId,
          weekday: 1,
          startMinute: 540,
          endMinute: 780,
        })
        .returning(),
    );

    expect(row).toMatchObject({ weekday: 1, startMinute: 540, endMinute: 780, removedAt: null });
  });

  it.each([
    ['an end before the start', { weekday: 1, startMinute: 600, endMinute: 540 }],
    ['an empty interval', { weekday: 1, startMinute: 600, endMinute: 600 }],
    ['an end after midnight', { weekday: 1, startMinute: 600, endMinute: 1441 }],
    ['weekday 0', { weekday: 0, startMinute: 600, endMinute: 700 }],
    ['weekday 8', { weekday: 8, startMinute: 600, endMinute: 700 }],
  ])('refuses %s', async (_name, interval) => {
    const professionalId = await makeProfessional();
    const locationId = await place();

    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx
          .insert(professionalHours)
          .values({ tenantId: a.id, professionalId, locationId, ...interval }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('refuses a location of another organization', async () => {
    const professionalId = await makeProfessional();
    const foreign = await place(b);

    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.insert(professionalHours).values({
          tenantId: a.id,
          professionalId,
          locationId: foreign,
          weekday: 1,
          startMinute: 540,
          endMinute: 600,
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });
});
