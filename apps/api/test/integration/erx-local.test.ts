import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  createLocalErxControls,
  createLocalPrescriptionProvider,
  type LocalErxControls,
} from '../../src/adapters/erx-local/index.js';
import { describePrescriptionProviderContract } from '../../src/adapters/prescription-provider.contract.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';

/**
 * The local e-prescription simulator (task 5.18) on a real Postgres: it passes the shared contract
 * suite the in-memory fake passes, it keeps its state in the database so the API and the worker see
 * the same one, it validates the medication against a catalog of generic names, and its controls
 * (mode, prescriptions, advance, reset) work.
 */

let runtime: DbHandle;
let controls: LocalErxControls;
const SECRET = 'a-secret-that-only-this-test-knows-0123456789';

beforeAll(() => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  controls = createLocalErxControls(runtime.db);
});

afterAll(async () => {
  await runtime.close();
});

beforeEach(async () => {
  await controls.setMode('ok');
});

const provider = () => createLocalPrescriptionProvider({ db: runtime.db, webhookSecret: SECRET });

describePrescriptionProviderContract({
  name: 'local simulator (Postgres)',
  make: () =>
    Promise.resolve({
      provider: provider(),
      setMode: (mode) => controls.setMode(mode),
      advance: async (externalId, to) => {
        await controls.advance(externalId, to);
      },
    }),
});

const request = (items: string[]) => ({
  matricula: { jurisdiction: 'AR-B', number: 'MP 12345' },
  patientDocument: { type: 'dni' as const, number: '30123456' },
  items,
});

let keys = 0;
const key = () => `local-erx-${String(Date.now())}-${String((keys += 1))}`;

describe('the local e-prescription simulator', () => {
  it('marks itself as a simulator', () => {
    expect(provider().simulated).toBe(true);
  });

  it('points the document at an address that says it is simulated and resolves to nothing', async () => {
    const result = await provider().issue(request(['Paracetamol 500 mg, cantidad 20']), key());

    if (result.status !== 'issued') throw new Error('not issued');
    expect(result.documentUrl).toMatch(/^local-erx:\/\/prescription\/ERX-[0-9A-F]{12}$/);
  });

  it('refuses a medication that is not in the catalog of generic names, and one that is a brand', async () => {
    const unknown = await provider().issue(request(['Zzzcilina 10 mg, cantidad 1']), key());
    const brand = await provider().issue(request(['Amoxidal 500 mg, cantidad 21']), key());
    const known = await provider().issue(request(['Losartan 50 mg, cantidad 30']), key());

    expect(unknown.status).toBe('rejected');
    expect(brand.status).toBe('rejected');
    expect(known.status).toBe('issued');
  });

  it('issues once when the same key arrives twice at the same time', async () => {
    const idempotencyKey = key();
    const items = ['Ibuprofeno 400 mg, cantidad 12'];

    const [first, second] = await Promise.all([
      provider().issue(request(items), idempotencyKey),
      provider().issue(request(items), idempotencyKey),
    ]);

    expect(first).toEqual(second);
    expect(first.status).toBe('issued');
    const listed = (await controls.prescriptions(200)).filter(
      (prescription) => first.status === 'issued' && prescription.externalId === first.externalId,
    );
    expect(listed).toHaveLength(1);
  });

  it('keeps its mode in the database, so the API and the worker see the same one', async () => {
    const api = createLocalErxControls(runtime.db);
    const worker = createLocalErxControls(runtime.db);

    await api.setMode('down');

    expect(await worker.mode()).toBe('down');
    expect(
      await provider().issue(request(['Paracetamol 500 mg, cantidad 20']), key()),
    ).toMatchObject({
      status: 'retryable',
      outcomeUnknown: false,
    });
  });

  it('fires timeout_after_issue once and goes back to ok by itself', async () => {
    await controls.setMode('timeout_after_issue');

    const lost = await provider().issue(request(['Paracetamol 500 mg, cantidad 20']), key());

    expect(lost).toMatchObject({ status: 'retryable', outcomeUnknown: true });
    expect(await controls.mode()).toBe('ok');
  });

  it('lists what it issued, newest first, with the state a pharmacy gave it', async () => {
    const first = await provider().issue(request(['Paracetamol 500 mg, cantidad 20']), key());
    const second = await provider().issue(request(['Omeprazol 20 mg, cantidad 28']), key());
    if (first.status !== 'issued' || second.status !== 'issued') throw new Error('not issued');
    await controls.advance(first.externalId, 'dispensed');

    const listed = await controls.prescriptions(200);

    const states = new Map(
      listed.map((prescription) => [prescription.externalId, prescription.state]),
    );
    expect(states.get(first.externalId)).toBe('dispensed');
    expect(states.get(second.externalId)).toBe('issued');
    const positions = listed.map((prescription) => prescription.externalId);
    expect(positions.indexOf(second.externalId)).toBeLessThan(positions.indexOf(first.externalId));
  });

  it('does not move a cancelled prescription to dispensed, and says whether it moved one', async () => {
    const issued = await provider().issue(request(['Paracetamol 500 mg, cantidad 20']), key());
    if (issued.status !== 'issued') throw new Error('not issued');
    await provider().cancel(issued.externalId, 'Error', key());

    const moved = await controls.advance(issued.externalId, 'dispensed');

    expect(moved).toBe(false);
    expect(await provider().status(issued.externalId)).toMatchObject({ state: 'cancelled' });
    expect(await controls.advance('NOT-A-PRESCRIPTION', 'expired')).toBe(false);
  });

  it('resets without deleting: the old prescriptions disappear from the list and the keys are free again', async () => {
    const idempotencyKey = key();
    const before = await provider().issue(
      request(['Paracetamol 500 mg, cantidad 20']),
      idempotencyKey,
    );
    await controls.setMode('down');

    await controls.reset();

    expect(await controls.mode()).toBe('ok');
    expect(await provider().findByKey(idempotencyKey)).toBeNull();
    const again = await provider().issue(
      request(['Paracetamol 500 mg, cantidad 20']),
      idempotencyKey,
    );
    expect(again).toEqual(before);
    expect((await controls.prescriptions(200)).length).toBe(1);
  });

  it('verifies the signature of its notices over the raw body, and refuses anything else', () => {
    const local = provider();
    const body = JSON.stringify({ eventId: 'e-1', externalId: 'ERX-1', state: 'dispensed' });
    const headers = local.signNotice(body);

    expect(local.verifyWebhook(Buffer.from(body), headers)).toBe(true);
    expect(local.verifyWebhook(Buffer.from(body + ' '), headers)).toBe(false);
    expect(local.verifyWebhook(Buffer.from(body), {})).toBe(false);
    expect(
      local.verifyWebhook(Buffer.from(body), {
        'x-erx-signature': 'sha256=00',
        'x-erx-timestamp': headers['x-erx-timestamp'],
      }),
    ).toBe(false);
    const other = createLocalPrescriptionProvider({
      db: runtime.db,
      webhookSecret: 'another-secret-0123456789abcdef',
    });
    expect(other.verifyWebhook(Buffer.from(body), headers)).toBe(false);
  });

  it('judges the freshness of a notice by its clock: five minutes either way, not a second more (JD-S5 R1-B-T3)', () => {
    const now = { value: new Date('2031-05-05T12:00:00.000Z') };
    const local = createLocalPrescriptionProvider({
      db: runtime.db,
      webhookSecret: 'a-secret-for-the-clock-0123456789',
      clock: () => now.value,
    });
    const body = JSON.stringify({ eventId: 'e-2', externalId: 'ERX-2', state: 'expired' });
    const headers = local.signNotice(body);

    expect(local.verifyWebhook(Buffer.from(body), headers)).toBe(true);
    now.value = new Date('2031-05-05T12:05:00.000Z');
    expect(local.verifyWebhook(Buffer.from(body), headers)).toBe(true);
    now.value = new Date('2031-05-05T12:05:01.000Z');
    expect(local.verifyWebhook(Buffer.from(body), headers)).toBe(false);
    now.value = new Date('2031-05-05T11:54:59.000Z');
    expect(local.verifyWebhook(Buffer.from(body), headers)).toBe(false);
  });
});

describe('the tables of the simulator', () => {
  it('cannot be deleted from or truncated, and the answers it gave cannot be changed, by the application role', async () => {
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
      );

    expect(await code(runtime.db.execute(sql`DELETE FROM local_erx_prescription`))).toBe('42501');
    expect(await code(runtime.db.execute(sql`DELETE FROM local_erx_request`))).toBe('42501');
    expect(await code(runtime.db.execute(sql`DELETE FROM local_erx_control`))).toBe('42501');
    expect(await code(runtime.db.execute(sql`UPDATE local_erx_request SET message = 'x'`))).toBe(
      '42501',
    );
  });

  it('has no tenant column and no clinical content: it is platform state', async () => {
    const result = await runtime.db.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name LIKE 'local_erx_%'`,
    );
    const columns = result.rows.map((row) => row.column_name);

    expect(columns).not.toContain('tenant_id');
    expect(columns).not.toContain('items');
    expect(columns).not.toContain('content');
  });
});
