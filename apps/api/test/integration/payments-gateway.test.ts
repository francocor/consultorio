import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  createLocalPaymentsControls,
  createLocalPaymentsGateway,
  hostedPageUrl,
  type LocalPaymentsControls,
  type LocalPaymentsGateway,
} from '../../src/adapters/mercadopago-local/index.js';
import {
  describePaymentsGatewayContract,
  type GatewayMode,
  type PaymentsGatewayHarness,
} from '../../src/adapters/payments-gateway.contract.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';

/**
 * The local Mercado Pago (task 6.13) on a real Postgres: it passes the shared contract suite that
 * the in-memory fake passes, in both kinds of provider (one that honours a repeated key and one
 * that does not), and it keeps its state in the database, so the API and the worker see the same
 * one. The hosted checkout and the notices it posts are in `mp-webhook.test.ts`.
 */

let runtime: DbHandle;
let controls: LocalPaymentsControls;
const SECRET = 'a-secret-that-only-this-test-knows-0123456789';
const NOW = new Date('2026-10-20T15:00:00.000Z');
const BASE = 'https://platform.consultorio.test/api';

beforeAll(() => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  controls = createLocalPaymentsControls(runtime.db, { clock: () => NOW });
});

afterAll(async () => {
  await runtime.close();
});

beforeEach(async () => {
  await controls.setMode('ok');
});

const gatewayOf = (idempotent: boolean): LocalPaymentsGateway =>
  createLocalPaymentsGateway({
    db: runtime.db,
    webhookSecret: SECRET,
    publicBaseUrl: BASE,
    idempotent,
    clock: () => NOW,
  });

function harnessFor(idempotent: boolean): PaymentsGatewayHarness {
  const gateway = gatewayOf(idempotent);
  return {
    gateway,
    secret: SECRET,
    now: () => NOW,
    setMode: (mode: GatewayMode) => controls.setMode(mode),
    authorize: async (id) => {
      await controls.decidePreapproval(id, 'approve');
    },
    chargeCycle: async (id, outcome) => {
      await controls.charge(id, outcome);
    },
    payLink: async (id) => {
      await controls.decideLink(id, 'approve');
    },
    sign: (body, ts) => Promise.resolve(gateway.sign(body, ts)),
  };
}

// The same suite against both kinds of provider: one that honours a repeated key and one that does not.
describePaymentsGatewayContract({
  name: 'local Mercado Pago (Postgres), does not honour the key',
  make: () => Promise.resolve(harnessFor(false)),
});
describePaymentsGatewayContract({
  name: 'local Mercado Pago (Postgres), honours the key',
  make: () => Promise.resolve(harnessFor(true)),
});

const request = (reference: string) => ({
  externalReference: reference,
  payerEmail: 'duena@clinica.example',
  reason: 'Plan Profesional',
  amountCents: 3_600_000,
  currency: 'ARS' as const,
  backUrl: 'https://clinica.consultorio.test/subscription',
});

let sequence = 0;
const reference = () => `local-mp-test-${String(Date.now())}-${String((sequence += 1))}`;

describe('the local Mercado Pago', () => {
  it('says what it is: simulated, and by default it does NOT honour a repeated key', () => {
    expect(gatewayOf(false)).toMatchObject({ simulated: true, honoursIdempotencyKey: false });
    expect(gatewayOf(true).honoursIdempotencyKey).toBe(true);
    expect(gatewayOf(false).settleWindowMs).toBeGreaterThan(0);
  });

  it('points the hosted page at the public address it was given, on the prefix of the simulators', async () => {
    const gateway = gatewayOf(false);
    const result = await gateway.createPreapproval(request(reference()), `key-${reference()}`);

    if (result.status !== 'created') throw new Error('not created');
    expect(result.preapproval.checkoutUrl).toBe(
      hostedPageUrl(BASE, result.preapproval.preapprovalId),
    );
    expect(result.preapproval.checkoutUrl).toMatch(
      /^https:\/\/platform\.consultorio\.test\/api\/local-providers\/mercadopago\/checkout\/PRE-[0-9A-F]{12}$/,
    );
  });

  it('makes two preapprovals for a key sent twice when it does not honour keys, and the search shows both', async () => {
    const gateway = gatewayOf(false);
    const ref = reference();
    const key = `key-${ref}`;

    await gateway.createPreapproval(request(ref), key);
    await gateway.createPreapproval(request(ref), key);

    const search = await gateway.findPreapprovalsByReference(ref);
    expect(search.status === 'ok' ? search.preapprovals : []).toHaveLength(2);
  });

  it('makes one preapproval for a key sent twice at the same time when it honours keys', async () => {
    const gateway = gatewayOf(true);
    const ref = reference();
    const key = `key-${ref}`;

    const [first, second] = await Promise.all([
      gateway.createPreapproval(request(ref), key),
      gateway.createPreapproval(request(ref), key),
    ]);

    expect(first).toEqual(second);
    const search = await gateway.findPreapprovalsByReference(ref);
    expect(search.status === 'ok' ? search.preapprovals : []).toHaveLength(1);
  });

  it('refuses a key that comes back with another request, when it honours keys', async () => {
    const gateway = gatewayOf(true);
    const key = `key-${reference()}`;
    await gateway.createPreapproval(request(reference()), key);

    const other = await gateway.createPreapproval(request(reference()), key);

    expect(other.status).toBe('rejected');
  });

  it('keeps its state in the database, so the API and the worker see the same one', async () => {
    const api = createLocalPaymentsControls(runtime.db);
    const worker = createLocalPaymentsControls(runtime.db);

    await api.setMode('down');

    expect(await worker.mode()).toBe('down');
    expect(
      await gatewayOf(false).createPreapproval(request(reference()), `key-${reference()}`),
    ).toMatchObject({ status: 'retryable', outcomeUnknown: false });
  });

  it('fires lose_answer once and goes back to ok by itself', async () => {
    await controls.setMode('lose_answer');

    const lost = await gatewayOf(false).createPreapproval(
      request(reference()),
      `key-${reference()}`,
    );

    expect(lost).toMatchObject({ status: 'retryable', outcomeUnknown: true });
    expect(await controls.mode()).toBe('ok');
  });

  it('applies the new amount of a reauthorization only when the payer approves it on the hosted page', async () => {
    const gateway = gatewayOf(false);
    const ref = reference();
    const created = await gateway.createPreapproval(request(ref), `key-${ref}`);
    if (created.status !== 'created') throw new Error('not created');
    const { preapprovalId } = created.preapproval;
    await controls.decidePreapproval(preapprovalId, 'approve');
    await controls.setMode('reauthorize');

    const asked = await gateway.updatePreapprovalAmount(
      { preapprovalId, amountCents: 5_000_000, externalReference: ref },
      `key-${reference()}`,
    );
    await controls.setMode('ok');
    const before = await gateway.getPreapproval(preapprovalId);
    await controls.decidePreapproval(preapprovalId, 'approve');
    const after = await gateway.getPreapproval(preapprovalId);

    expect(asked.status).toBe('reauthorization_required');
    expect(before.status === 'found' ? before.preapproval.amountCents : 0).toBe(3_600_000);
    expect(after.status === 'found' ? after.preapproval.amountCents : 0).toBe(5_000_000);
  });

  it('charges every authorized preapproval when the billing cycle runs, and nothing that is not authorized', async () => {
    const gateway = gatewayOf(false);
    const authorized = reference();
    const waiting = reference();
    const a = await gateway.createPreapproval(request(authorized), `key-${authorized}`);
    const b = await gateway.createPreapproval(request(waiting), `key-${waiting}`);
    if (a.status !== 'created' || b.status !== 'created') throw new Error('not created');
    await controls.decidePreapproval(a.preapproval.preapprovalId, 'approve');

    const made = await controls.runBillingCycle('approved');

    expect(made.length).toBeGreaterThanOrEqual(1);
    const mine = await gateway.findPayments({ preapprovalId: a.preapproval.preapprovalId });
    const others = await gateway.findPayments({ preapprovalId: b.preapproval.preapprovalId });
    expect(mine.status === 'ok' ? mine.payments.map((entry) => entry.status) : []).toEqual([
      'approved',
    ]);
    expect(others.status === 'ok' ? others.payments : []).toEqual([]);
  });

  it('keeps no card and no payer name: the tables hold a reference, an address, an amount and a label', async () => {
    const columns = await runtime.db.execute<{ column_name: string }>(
      sql`select column_name from information_schema.columns
           where table_schema = 'public' and table_name like 'local_mp_%'`,
    );

    const names = columns.rows.map((row) => row.column_name);
    for (const forbidden of ['card', 'number', 'pan', 'cvv', 'token', 'secret', 'name']) {
      expect(
        names.filter((name) => name.includes(forbidden)),
        forbidden,
      ).toEqual([]);
    }
  });

  it('forgets everything on reset without deleting a row, and goes back to ok', async () => {
    const gateway = gatewayOf(false);
    const ref = reference();
    await gateway.createPreapproval(request(ref), `key-${ref}`);
    await controls.setMode('down');

    await controls.reset();

    expect(await controls.mode()).toBe('ok');
    const search = await gateway.findPreapprovalsByReference(ref);
    expect(search.status === 'ok' ? search.preapprovals : ['x']).toEqual([]);
    const rows = await runtime.db.execute<{ n: number }>(
      sql`select count(*)::int as n from local_mp_preapproval where external_reference = ${ref}`,
    );
    expect(rows.rows[0]?.n).toBe(1);
  });
});
