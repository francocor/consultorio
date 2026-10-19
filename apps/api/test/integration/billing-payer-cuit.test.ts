import type { PayerListResponse, Problem, TenantPayerDto } from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBillingWorld, type BillingWorld } from '../support/billing-world.js';
import { asTenant } from '../support/tenants.js';

/**
 * The CUIT of a payer (billing-payments, "Payer and plan catalog"; e-invoicing-afip: a Factura A to a
 * payer needs it). The platform catalog has none, so the organization enters it for each payer, and
 * the country pack checks the digits and the check digit.
 */

const VALID = '30-70857833-5';
const DIGITS = '30708578335';

let runtime: DbHandle;
let world: BillingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBillingWorld(runtime, { slug: 'billing-payer-cuit' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const create = (body: Record<string, unknown>, by = world.owner) =>
  world.api.post('/billing/payers', by, body);

async function changes() {
  const rows = await asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.tenantId, world.tenant.id),
          eq(auditEvent.action, 'billing.price.changed'),
        ),
      )
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return rows.map((row) => row.metadata);
}

describe('the CUIT of a payer', () => {
  it('is empty until the organization enters it', async () => {
    const created = await create({ customName: 'Mutual Sin Cuit' });

    expect(created.statusCode, created.body).toBe(201);
    expect(created.json<TenantPayerDto>().cuit).toBeNull();
  });

  it('is stored as its eleven digits, however it was typed', async () => {
    const dashed = await create({ customName: 'Mutual Con Guiones', cuit: VALID });
    const plain = await create({ customName: 'Mutual Con Digitos', cuit: DIGITS });

    expect(dashed.json<TenantPayerDto>().cuit).toBe(DIGITS);
    expect(plain.json<TenantPayerDto>().cuit).toBe(DIGITS);
    const listed = (
      await world.api.get('/billing/payers', world.reception)
    ).json<PayerListResponse>();
    expect(listed.payers.filter((entry) => entry.cuit === DIGITS)).toHaveLength(2);
  });

  it('can be given to a payer copied from the catalog', async () => {
    const catalogId = await world.catalogPayer('billing-cuit-osde', 'OSDE Con CUIT');

    const created = await create({ payerId: catalogId, cuit: VALID });

    expect(created.json<TenantPayerDto>()).toMatchObject({ name: 'OSDE Con CUIT', cuit: DIGITS });
  });

  it('is refused when the check digit or the digits are wrong, with the field named', async () => {
    for (const cuit of [
      '30-70857833-1',
      '30-7085783-0',
      '99-70857833-0',
      'treinta',
      '2030708578335',
    ]) {
      const response = await create({ customName: `Mutual ${cuit}`, cuit });

      expect(response.statusCode, cuit).toBe(400);
      expect(response.json<Problem>().errors, cuit).toEqual([
        { path: 'cuit', i18nKey: 'country.ar.tax_id.invalid' },
      ]);
    }
  });

  it('is set, changed and removed on an existing payer, audited without being written down', async () => {
    const payer = (await create({ customName: 'Mutual Que Cambia' })).json<TenantPayerDto>();

    const set = await world.api.patch(`/billing/payers/${payer.id}`, world.owner, { cuit: VALID });
    const same = await world.api.patch(`/billing/payers/${payer.id}`, world.owner, {
      cuit: DIGITS,
    });
    const removed = await world.api.patch(`/billing/payers/${payer.id}`, world.owner, {
      cuit: null,
    });
    const wrong = await world.api.patch(`/billing/payers/${payer.id}`, world.owner, {
      cuit: '30-70857833-4',
    });

    expect(set.json<TenantPayerDto>().cuit).toBe(DIGITS);
    expect(same.statusCode).toBe(200);
    expect(removed.json<TenantPayerDto>().cuit).toBeNull();
    expect(wrong.statusCode).toBe(400);
    const log = (await changes()).filter((entry) => entry['change'] === 'cuit_changed');
    expect(log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: 'payer', cuit: true }),
        expect.objectContaining({ entity: 'payer', cuit: false }),
      ]),
    );
    // Setting the same CUIT again writes no entry, and the number itself is never in the log.
    expect(log.filter((entry) => entry['cuit'] === true)).toHaveLength(1);
    expect(JSON.stringify(await changes())).not.toContain(DIGITS);
  });

  it('is changed together with the state of the payer, and a request that changes nothing is refused', async () => {
    const payer = (await create({ customName: 'Mutual Doble Cambio' })).json<TenantPayerDto>();

    const both = await world.api.patch(`/billing/payers/${payer.id}`, world.owner, {
      active: false,
      cuit: VALID,
    });
    const nothing = await world.api.patch(`/billing/payers/${payer.id}`, world.owner, {});

    expect(both.json<TenantPayerDto>()).toMatchObject({ active: false, cuit: DIGITS });
    expect(nothing.statusCode).toBe(400);
  });

  it('can be changed only by who manages prices, and is read by whoever reads payments', async () => {
    const payer = (
      await create({ customName: 'Mutual Protegida', cuit: VALID })
    ).json<TenantPayerDto>();

    const byReception = await world.api.patch(`/billing/payers/${payer.id}`, world.reception, {
      cuit: null,
    });
    const read = await world.api.get('/billing/payers', world.reception);

    expect(byReception.statusCode).toBe(403);
    expect(read.json<PayerListResponse>().payers.find((entry) => entry.id === payer.id)?.cuit).toBe(
      DIGITS,
    );
  });

  it('cannot hold anything but eleven digits in the database', async () => {
    const code = await asTenant(runtime, world.tenant.id, (tx) =>
      tx
        .transaction((inner) =>
          inner.execute(
            sql`INSERT INTO tenant_payer (tenant_id, custom_name, cuit)
                  VALUES (${world.tenant.id}, 'Mutual Mal Guardada', '30-70857833-5')`,
          ),
        )
        .then(
          () => undefined,
          (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
        ),
    );

    expect(code).toBe('23514');
  });
});
