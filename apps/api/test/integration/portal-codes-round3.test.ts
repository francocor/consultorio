import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { sendsInLastHour as bookingSends } from '../../src/modules/online-booking/application/otp.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createPortalWorld, type PortalWorld } from '../support/portal-world.js';

/**
 * JD-S5 R3-1: a decoy of the portal (the answer for an address that must not get a code) is
 * harmless to everyone and costs a bounded amount:
 *
 * - it is not one of the three codes an hour that the BOOKING (and the waitlist) may send to the
 *   address, so a stranger cannot burn the budget of a victim who is booking an appointment;
 * - an address has its own cap of three decoys an hour, counted among decoys only: above it the
 *   answer is the same but nothing is written and no job is queued, so a flood from many clients
 *   cannot fill `otp_challenge` and the queue.
 */
const SLUG = 'portal-codes-round3';
let runtime: DbHandle;
let world: PortalWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createPortalWorld(runtime, { slug: SLUG, ports: {} });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const address = (prefix: string) => `${prefix}-${randomUUID().slice(0, 6)}@example.test`;
const nationalIdOf = () => String(30_000_000 + Math.floor(Math.random() * 9_000_000));

async function askToRegister(
  who: ReturnType<PortalWorld['visitor']>,
  input: { nationalId: string; email: string },
) {
  return who.post(`/public/${SLUG}/portal/register`, {
    ...input,
    challengeProof: await who.solve(),
  });
}

const rowsFor = (email: string) =>
  world.inTenant((tx) =>
    tx.execute<{ purpose: string }>(
      sql`select purpose from otp_challenge where email = ${email} order by created_at`,
    ),
  );

describe('R3-1: decoys do not limit the booking and are capped on their own', () => {
  it('does not count decoys in the sends an hour that the booking checks', async () => {
    const email = address('reserva');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const decoy = await askToRegister(world.visitor({ ip: `10.50.1.${String(attempt + 1)}` }), {
        nationalId: nationalIdOf(),
        email,
      });
      expect(decoy.statusCode, decoy.body).toBe(200);
    }

    const rows = await rowsFor(email);
    expect(rows.rows.map((row) => row.purpose)).toEqual([
      'portal_decoy',
      'portal_decoy',
      'portal_decoy',
    ]);
    const counted = await world.inTenant((tx) => bookingSends(tx, email, new Date()));
    expect(counted).toBe(0);
  });

  it('caps the decoys of an address at three an hour, from any number of clients', async () => {
    const email = address('inundacion');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      // A different client each time, so the per-client allowance never stops it.
      const decoy = await askToRegister(world.visitor({ ip: `10.50.2.${String(attempt + 1)}` }), {
        nationalId: nationalIdOf(),
        email,
      });
      expect(decoy.statusCode, decoy.body).toBe(200);
    }
    await world.runJobs();

    const rows = await rowsFor(email);
    expect(rows.rows).toHaveLength(3);
    expect(world.email.lastTo(email)).toBeUndefined();
  });

  it('keeps the decoy cap apart from the real sends: a patient still gets the code', async () => {
    const email = address('real');
    const nationalId = nationalIdOf();
    await world.patientWith({ email, nationalIdType: 'dni', nationalId, birthDate: '1985-03-10' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await askToRegister(world.visitor({ ip: `10.50.3.${String(attempt + 1)}` }), {
        nationalId: nationalIdOf(),
        email,
      });
    }

    const patient = world.visitor({ ip: '10.50.3.99' });
    expect((await askToRegister(patient, { nationalId, email })).statusCode).toBe(200);
    await world.runJobs();

    expect(world.codeSentTo(email)).toMatch(/^\d{6}$/);
  });
});
