import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { Tx } from '../../src/platform/db/tenant-context.js';
import {
  insertLocation,
  insertProfessional,
  returningId,
  unique,
} from '../support/fixture-helpers.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;
let catalogPayerId: string;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'billing-pricing-a' });
  b = await createTestTenant(runtime, { slug: 'billing-pricing-b' });
  const owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  const inserted = await owner.query<{ id: string }>(
    "insert into payer (country, code, name, kind) values ('AR', 'billing-pricing', 'Obra de precios', 'obra_social') on conflict (country, code) do update set name = excluded.name returning id",
  );
  await owner.end();
  catalogPayerId = inserted.rows[0]?.id ?? '';
});

afterAll(async () => {
  await runtime.close();
});

/** The SQLSTATE of a refused statement, run in a savepoint so the transaction stays usable. */
const refusal = (tx: Tx, work: (inner: Tx) => Promise<unknown>) =>
  tx.transaction(work).then(
    () => undefined,
    (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
  );

const type = (tx: Tx) =>
  returningId(
    tx,
    sql`INSERT INTO appointment_type (tenant_id, name, duration_minutes)
          VALUES (${a.id}, ${unique('Consulta')}, 30) RETURNING id`,
  );

interface PriceValues {
  typeId: string;
  amount?: number;
  professionalId?: string | null;
  specialty?: string | null;
  locationId?: string | null;
  effectiveFrom?: string;
  active?: boolean;
}

const price = (tx: Tx, values: PriceValues) =>
  returningId(
    tx,
    sql`INSERT INTO price (tenant_id, appointment_type_id, professional_id, specialty, location_id,
                           amount_cents, effective_from, active)
          VALUES (${a.id}, ${values.typeId}, ${values.professionalId ?? null},
                  ${values.specialty ?? null}, ${values.locationId ?? null},
                  ${values.amount ?? 2_000_000}, ${values.effectiveFrom ?? '2031-01-01'},
                  ${values.active ?? true})
          RETURNING id`,
  );

describe('price', () => {
  it('keeps an amount in whole cents, effective from a date', async () => {
    const row = await asTenant(runtime, a.id, async (tx) => {
      const id = await price(tx, { typeId: await type(tx), amount: 2_000_050 });
      return (
        await tx.execute(
          sql`SELECT amount_cents, effective_from, active FROM price WHERE id = ${id}`,
        )
      ).rows[0];
    });

    expect(row).toMatchObject({ amount_cents: '2000050', active: true });
  });

  it('refuses a negative or a zero amount', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const typeId = await type(tx);
      return [
        await refusal(tx, (inner) => price(inner, { typeId, amount: -1 })),
        await refusal(tx, (inner) => price(inner, { typeId, amount: 0 })),
      ];
    });

    expect(codes).toEqual(['23514', '23514']);
  });

  it('refuses a second active price for the same scope and date, and allows another scope', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const typeId = await type(tx);
      const professionalId = await insertProfessional(tx, a.id);
      const locationId = await insertLocation(tx, a.id);
      await price(tx, { typeId });
      const same = await refusal(tx, (inner) => price(inner, { typeId, amount: 3_000_000 }));
      const otherDate = await refusal(tx, (inner) =>
        price(inner, { typeId, effectiveFrom: '2031-06-01' }),
      );
      const otherProfessional = await refusal(tx, (inner) =>
        price(inner, { typeId, professionalId }),
      );
      const otherLocation = await refusal(tx, (inner) => price(inner, { typeId, locationId }));
      const otherSpecialty = await refusal(tx, (inner) =>
        price(inner, { typeId, specialty: 'pediatría' }),
      );
      return { same, otherDate, otherProfessional, otherLocation, otherSpecialty };
    });

    expect(result).toEqual({
      same: '23505',
      otherDate: undefined,
      otherProfessional: undefined,
      otherLocation: undefined,
      otherSpecialty: undefined,
    });
  });

  it('lets an inactive price share the scope and date of an active one', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const typeId = await type(tx);
      await price(tx, { typeId });
      return refusal(tx, (inner) => price(inner, { typeId, active: false }));
    });

    expect(code).toBeUndefined();
  });

  it('cannot be deleted by the application role', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const id = await price(tx, { typeId: await type(tx) });
      return refusal(tx, (inner) => inner.execute(sql`DELETE FROM price WHERE id = ${id}`));
    });

    expect(code).toBe('42501');
  });
});

describe('tenant_payer', () => {
  const payer = (
    tx: Tx,
    values: { payerId?: string | null; customName?: string | null; active?: boolean },
  ) =>
    returningId(
      tx,
      sql`INSERT INTO tenant_payer (tenant_id, payer_id, custom_name, active, deactivated_at)
            VALUES (${a.id}, ${values.payerId ?? null}, ${values.customName ?? null},
                    ${values.active ?? true},
                    ${values.active === false ? sql`now()` : null})
            RETURNING id`,
    );

  it('copies a payer of the platform catalog or names a custom one, never both or neither', async () => {
    expect(catalogPayerId).not.toBe('');
    const codes = await asTenant(runtime, a.id, async (tx) => {
      await payer(tx, { payerId: catalogPayerId });
      await payer(tx, { customName: unique('Mutual') });
      return [
        await refusal(tx, (inner) =>
          payer(inner, { payerId: catalogPayerId, customName: 'Ambos' }),
        ),
        await refusal(tx, (inner) => payer(inner, {})),
      ];
    });

    expect(codes).toEqual(['23514', '23514']);
  });

  it('lists a payer once, and a custom name once whatever its case', async () => {
    const result = await asTenant(runtime, b.id, async (tx) => {
      const insert = (values: { payerId?: string; customName?: string }) =>
        refusal(tx, (inner) =>
          inner.execute(
            sql`INSERT INTO tenant_payer (tenant_id, payer_id, custom_name)
                  VALUES (${b.id}, ${values.payerId ?? null}, ${values.customName ?? null})`,
          ),
        );
      return {
        firstCatalog: await insert({ payerId: catalogPayerId }),
        secondCatalog: await insert({ payerId: catalogPayerId }),
        firstCustom: await insert({ customName: 'Una Mutual' }),
        sameCustomOtherCase: await insert({ customName: 'UNA MUTUAL' }),
      };
    });

    expect(result).toEqual({
      firstCatalog: undefined,
      secondCatalog: '23505',
      firstCustom: undefined,
      sameCustomOtherCase: '23505',
    });
  });

  it('is deactivated together with the moment it was deactivated, or neither', async () => {
    const code = await asTenant(runtime, a.id, async (tx) =>
      refusal(tx, (inner) =>
        inner.execute(
          sql`INSERT INTO tenant_payer (tenant_id, custom_name, active, deactivated_at)
                VALUES (${a.id}, ${unique('Mutual')}, false, null)`,
        ),
      ),
    );

    expect(code).toBe('23514');
  });
});

describe('payer_plan_price', () => {
  const planPrice = (
    tx: Tx,
    values: {
      payerId: string;
      typeId: string;
      planName?: string | null;
      payerAmount?: number;
      copago?: number;
      plus?: number;
      effectiveFrom?: string;
    },
  ) =>
    returningId(
      tx,
      sql`INSERT INTO payer_plan_price (tenant_id, tenant_payer_id, plan_name, appointment_type_id,
                                        payer_amount_cents, copago_cents, plus_cents, effective_from)
            VALUES (${a.id}, ${values.payerId}, ${values.planName ?? null}, ${values.typeId},
                    ${values.payerAmount ?? 1_500_000}, ${values.copago ?? 300_000},
                    ${values.plus ?? 0}, ${values.effectiveFrom ?? '2031-01-01'})
            RETURNING id`,
    );

  const tenantPayer = (tx: Tx) =>
    returningId(
      tx,
      sql`INSERT INTO tenant_payer (tenant_id, custom_name) VALUES (${a.id}, ${unique('Prepaga')}) RETURNING id`,
    );

  it('keeps what the payer covers, the copago and the plus apart', async () => {
    const row = await asTenant(runtime, a.id, async (tx) => {
      const id = await planPrice(tx, {
        payerId: await tenantPayer(tx),
        typeId: await type(tx),
        payerAmount: 1_500_000,
        copago: 300_000,
        plus: 500_000,
      });
      return (
        await tx.execute(
          sql`SELECT payer_amount_cents, copago_cents, plus_cents FROM payer_plan_price WHERE id = ${id}`,
        )
      ).rows[0];
    });

    expect(row).toMatchObject({
      payer_amount_cents: '1500000',
      copago_cents: '300000',
      plus_cents: '500000',
    });
  });

  it('refuses a negative part, and a price that adds up to nothing', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const payerId = await tenantPayer(tx);
      const typeId = await type(tx);
      return [
        await refusal(tx, (inner) => planPrice(inner, { payerId, typeId, copago: -1 })),
        await refusal(tx, (inner) => planPrice(inner, { payerId, typeId, payerAmount: -5 })),
        await refusal(tx, (inner) => planPrice(inner, { payerId, typeId, plus: -1 })),
        await refusal(tx, (inner) =>
          planPrice(inner, { payerId, typeId, payerAmount: 0, copago: 0, plus: 0 }),
        ),
      ];
    });

    expect(codes).toEqual(['23514', '23514', '23514', '23514']);
  });

  it('allows a payer that covers all of it (no copago) and refuses the same plan and date twice', async () => {
    const result = await asTenant(runtime, a.id, async (tx) => {
      const payerId = await tenantPayer(tx);
      const typeId = await type(tx);
      const free = await refusal(tx, (inner) =>
        planPrice(inner, { payerId, typeId, planName: '210', copago: 0 }),
      );
      const twice = await refusal(tx, (inner) =>
        planPrice(inner, { payerId, typeId, planName: '210', copago: 0 }),
      );
      const otherPlan = await refusal(tx, (inner) =>
        planPrice(inner, { payerId, typeId, planName: '310' }),
      );
      const wholePayer = await refusal(tx, (inner) => planPrice(inner, { payerId, typeId }));
      return { free, twice, otherPlan, wholePayer };
    });

    expect(result).toEqual({
      free: undefined,
      twice: '23505',
      otherPlan: undefined,
      wholePayer: undefined,
    });
  });

  it('cannot be deleted by the application role', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const id = await planPrice(tx, { payerId: await tenantPayer(tx), typeId: await type(tx) });
      return refusal(tx, (inner) =>
        inner.execute(sql`DELETE FROM payer_plan_price WHERE id = ${id}`),
      );
    });

    expect(code).toBe('42501');
  });
});
