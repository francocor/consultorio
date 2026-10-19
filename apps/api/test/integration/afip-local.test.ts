import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  createLocalAfipControls,
  createLocalInvoiceIssuer,
  type LocalAfipControls,
} from '../../src/adapters/afip-local/index.js';
import {
  describeInvoiceIssuerContract,
  nextCuit,
} from '../../src/adapters/invoice-issuer.contract.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';

/**
 * The local AFIP simulator (task 4.40) on a real Postgres: it passes the shared contract suite, its
 * numbering holds under concurrency, its state is shared by every process that opens it, and its
 * controls (mode, vouchers, reset) work. The fake passes the same suite in
 * `src/adapters/afip-fake/index.test.ts`.
 */

let runtime: DbHandle;
let controls: LocalAfipControls;

beforeAll(() => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  controls = createLocalAfipControls(runtime.db);
});

afterAll(async () => {
  await runtime.close();
});

beforeEach(async () => {
  await controls.setMode('ok');
});

const issuer = () => createLocalInvoiceIssuer({ db: runtime.db, slowMs: 5 });

describeInvoiceIssuerContract({
  name: 'local simulator (Postgres)',
  make: () => Promise.resolve({ issuer: issuer(), setMode: (mode) => controls.setMode(mode) }),
});

const request = (cuit: string, overrides: Record<string, unknown> = {}) => ({
  issuerCuit: cuit,
  pointOfSale: 1,
  type: 'FC',
  issueDate: '2026-10-17',
  currency: 'ARS',
  totalCents: 1_000_000,
  ...overrides,
});

describe('the local AFIP simulator', () => {
  it('marks itself as a simulator', () => {
    expect(issuer().simulated).toBe(true);
  });

  it('numbers without gaps or repeats when many requests arrive at once', async () => {
    const cuit = nextCuit();

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, at) =>
        issuer().issue(request(cuit), `concurrent-${cuit}-${String(at)}`),
      ),
    );

    const numbers = results
      .map((result) => (result.status === 'issued' ? result.number : -1))
      .sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('issues once when the same key arrives twice at the same time', async () => {
    const cuit = nextCuit();

    const [first, second] = await Promise.all([
      issuer().issue(request(cuit), `twice-${cuit}`),
      issuer().issue(request(cuit), `twice-${cuit}`),
    ]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: 'issued', number: 1 });
    expect(
      await issuer().findIssued({ issuerCuit: cuit, pointOfSale: 1, type: 'FC', number: 2 }),
    ).toBeNull();
  });

  it('keeps its mode in the database, so the API and the worker see the same one', async () => {
    const api = createLocalAfipControls(runtime.db);
    const worker = createLocalAfipControls(runtime.db);

    await api.setMode('down');

    expect(await worker.mode()).toBe('down');
    expect(await issuer().issue(request(nextCuit()), 'mode-shared')).toMatchObject({
      status: 'retryable',
      outcomeUnknown: false,
    });
  });

  it('fires timeout_after_authorize and reject_next once and goes back to ok by itself', async () => {
    await controls.setMode('timeout_after_authorize');
    await issuer().issue(request(nextCuit()), 'one-shot-1');
    const afterTimeout = await controls.mode();
    await controls.setMode('reject_next');
    await issuer().issue(request(nextCuit()), 'one-shot-2');

    expect(afterTimeout).toBe('ok');
    expect(await controls.mode()).toBe('ok');
  });

  it('keeps sticky modes (down, slow) until someone changes them', async () => {
    await controls.setMode('slow');
    await issuer().issue(request(nextCuit()), 'sticky-1');

    expect(await controls.mode()).toBe('slow');
  });

  it('lists the vouchers it issued, newest first, with the CAE and its expiry', async () => {
    const cuit = nextCuit();
    await issuer().issue(request(cuit), `list-${cuit}-1`);
    await issuer().issue(request(cuit, { totalCents: 250_000 }), `list-${cuit}-2`);

    const listed = (await controls.vouchers(50)).filter((voucher) => voucher.issuerCuit === cuit);

    expect(listed.map((voucher) => [voucher.number, voucher.totalCents])).toEqual([
      [2, 250_000],
      [1, 1_000_000],
    ]);
    expect(listed[0]).toMatchObject({
      pointOfSale: 1,
      type: 'FC',
      caeExpiresOn: '2026-10-27',
      issueDate: '2026-10-17',
    });
    expect(listed[0]?.cae).toMatch(/^\d{14}$/);
  });

  it('resets without deleting: numbering starts again, the old vouchers disappear from the list', async () => {
    const cuit = nextCuit();
    await issuer().issue(request(cuit), `reset-${cuit}-1`);
    await controls.setMode('down');

    await controls.reset();

    expect(await controls.mode()).toBe('ok');
    expect((await controls.vouchers(50)).filter((voucher) => voucher.issuerCuit === cuit)).toEqual(
      [],
    );
    expect(await issuer().issue(request(cuit), `reset-${cuit}-2`)).toMatchObject({
      status: 'issued',
      number: 1,
    });
    // The key that was used before the reset is a new key after it.
    expect(
      await issuer().findIssued({ issuerCuit: cuit, pointOfSale: 1, type: 'FC', number: 2 }),
    ).toBeNull();
  });
});

describe('the tables of the simulator', () => {
  it('cannot be deleted from, truncated or (vouchers and requests) updated by the application role', async () => {
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
      );

    expect(await code(runtime.db.execute(sql`DELETE FROM local_afip_voucher`))).toBe('42501');
    expect(await code(runtime.db.execute(sql`DELETE FROM local_afip_request`))).toBe('42501');
    expect(await code(runtime.db.execute(sql`DELETE FROM local_afip_control`))).toBe('42501');
    expect(await code(runtime.db.execute(sql`UPDATE local_afip_voucher SET cae = '1'`))).toBe(
      '42501',
    );
    expect(await code(runtime.db.execute(sql`UPDATE local_afip_request SET message = 'x'`))).toBe(
      '42501',
    );
  });

  it('has no tenant column: it is platform state, not an organization data', async () => {
    const result = await runtime.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM information_schema.columns
           WHERE table_name LIKE 'local_afip_%' AND column_name = 'tenant_id'`,
    );

    expect(result.rows[0]?.n).toBe(0);
  });
});
