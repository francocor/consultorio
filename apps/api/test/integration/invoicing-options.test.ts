import type { InvoicingOptionsDto } from '@consultorio/contracts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createInvoicingWorld, type InvoicingWorld } from '../support/invoicing-world.js';

/**
 * What the form of an invoice needs (S4.13, task 4.55: "the type shown by the rules, not selectable
 * beyond them"): the type each kind of recipient gets, from the country pack, and the points of sale
 * that can be used. Reception reads it; the configuration itself stays with owner and admin.
 */

let runtime: DbHandle;
let world: InvoicingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createInvoicingWorld(runtime, { slug: 'invoicing-options' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const options = async (by = world.reception) => {
  const response = await world.api.get('/invoicing/options', by);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<InvoicingOptionsDto>();
};

const typeFor = (dto: InvoicingOptionsDto, recipient: string) =>
  dto.types.find((entry) => entry.recipient === recipient)?.type;

describe('the options of the invoice form', () => {
  it('gives a monotributista Factura C for every recipient', async () => {
    const dto = await options();

    expect(dto.taxCondition).toBe('monotributo');
    expect(dto.types).toHaveLength(4);
    for (const recipient of [
      'consumidor_final',
      'responsable_inscripto',
      'monotributo',
      'exento',
    ]) {
      expect(typeFor(dto, recipient), recipient).toBe('FC');
    }
  });

  it('gives a responsable inscripto A for a company and B for anyone else', async () => {
    await world.setTaxCondition('responsable_inscripto');
    try {
      const dto = await options();

      expect(dto.taxCondition).toBe('responsable_inscripto');
      expect(typeFor(dto, 'responsable_inscripto')).toBe('FA');
      expect(typeFor(dto, 'consumidor_final')).toBe('FB');
      expect(typeFor(dto, 'monotributo')).toBe('FB');
      expect(typeFor(dto, 'exento')).toBe('FB');
    } finally {
      await world.setTaxCondition('monotributo');
    }
  });

  it('lists the active points of sale with the environment that is really used', async () => {
    const created = await world.api.post('/invoicing/points-of-sale', world.owner, {
      number: 7,
      environment: 'production',
    });
    expect(created.statusCode, created.body).toBe(201);
    const inactive = await world.api.post('/invoicing/points-of-sale', world.owner, { number: 8 });
    await world.api.patch(
      `/invoicing/points-of-sale/${inactive.json<{ id: string }>().id}`,
      world.owner,
      {
        active: false,
      },
    );

    const dto = await options();

    // The world runs on a simulator: whatever was chosen, the environment used is the test one.
    expect(dto.pointsOfSale).toEqual([
      { number: 1, environment: 'homologation' },
      { number: 7, environment: 'homologation' },
    ]);
  });

  it('is open to who issues invoices and closed to a professional', async () => {
    expect((await world.api.get('/invoicing/options', world.owner)).statusCode).toBe(200);
    expect((await world.api.get('/invoicing/options', world.admin)).statusCode).toBe(200);
    expect((await world.api.get('/invoicing/options', world.doctor)).statusCode).toBe(403);
    expect((await world.api.get('/invoicing/options', null)).statusCode).toBe(401);
  });
});
