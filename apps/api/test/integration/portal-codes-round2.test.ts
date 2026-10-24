import { randomUUID } from 'node:crypto';

import type { Problem } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createPortalWorld, type PortalWorld } from '../support/portal-world.js';

/**
 * JD-S5 R2, the codes of the portal:
 *
 * - R2-1: a decoy challenge (the answer for an address that must not get a code) must not take part
 *   in anything: it cannot end the live registration code of the person whose address it names, and
 *   it does not count among the three sends an hour of that address;
 * - R2-4: the tries to use a code are counted per challenge AND per client (five each), with a cap
 *   of twenty on the challenge, so a stranger who knows an address cannot burn its code, and a
 *   client cannot ask for codes without limit.
 */
const SLUG = 'portal-codes-round2';
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
const problemOf = (response: LightMyRequestResponse) => response.json<Problem>();

/** A patient with a document and an address on the record who has no portal account yet. */
async function unregistered() {
  const email = address('victima');
  const nationalId = nationalIdOf();
  await world.patientWith({ email, nationalIdType: 'dni', nationalId, birthDate: '1985-03-10' });
  return { email, nationalId };
}

async function askToRegister(
  who: ReturnType<PortalWorld['visitor']>,
  input: { nationalId: string; email: string },
) {
  return who.post(`/public/${SLUG}/portal/register`, {
    ...input,
    challengeProof: await who.solve(),
  });
}

const registerWith = (
  who: ReturnType<PortalWorld['visitor']>,
  input: { nationalId: string; email: string; code: string },
) => who.post(`/public/${SLUG}/portal/register/verify`, input);

async function askForSignInCode(who: ReturnType<PortalWorld['visitor']>, email: string) {
  return who.post(`/public/${SLUG}/portal/otp`, { email, challengeProof: await who.solve() });
}

const signInWith = (who: ReturnType<PortalWorld['visitor']>, email: string, code: string) =>
  who.post(`/public/${SLUG}/portal/otp/verify`, { email, code });

describe('R2-1: a decoy challenge takes no part in anything', () => {
  it('does not end the live registration code of the address when a stranger tries a wrong document', async () => {
    const { email, nationalId } = await unregistered();
    const patient = world.visitor({ ip: '10.40.1.1' });
    const stranger = world.visitor({ ip: '10.40.9.9' });
    expect((await askToRegister(patient, { nationalId, email })).statusCode).toBe(200);
    await world.runJobs();
    const code = world.codeSentTo(email);

    // The stranger knows the address, not the document: the answer is the same and a decoy is written.
    const decoy = await askToRegister(stranger, { nationalId: nationalIdOf(), email });
    expect(decoy.statusCode, decoy.body).toBe(200);
    await world.runJobs();

    const done = await registerWith(patient, { nationalId, email, code });
    expect(done.statusCode, done.body).toBe(200);
  });

  it('does not use up the three sends an hour of the address', async () => {
    const { email, nationalId } = await unregistered();
    const stranger = world.visitor({ ip: '10.40.9.10' });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const decoy = await askToRegister(stranger, { nationalId: nationalIdOf(), email });
      expect(decoy.statusCode, decoy.body).toBe(200);
    }
    await world.runJobs();
    expect(world.email.lastTo(email)).toBeUndefined();

    // The patient asks now and gets the code.
    const patient = world.visitor({ ip: '10.40.1.2' });
    expect((await askToRegister(patient, { nationalId, email })).statusCode).toBe(200);
    await world.runJobs();
    const code = world.codeSentTo(email);
    const done = await registerWith(patient, { nationalId, email, code });
    expect(done.statusCode, done.body).toBe(200);
  });

  it('still limits the REAL sends of an address to three an hour', async () => {
    const { email, nationalId } = await unregistered();
    const patient = world.visitor({ ip: '10.40.1.3' });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await askToRegister(patient, { nationalId, email })).statusCode).toBe(200);
      await world.runJobs();
    }

    const sent = world.email.sent.filter((message) => message.to.toLowerCase() === email);
    expect(sent).toHaveLength(3);
  });

  it('does not end the live sign-in code of an address either (a decoy for the registration of the same address)', async () => {
    const { email } = await world.patientSession();
    const patient = world.visitor({ ip: '10.40.1.4' });
    expect((await askForSignInCode(patient, email)).statusCode).toBe(200);
    await world.runJobs();
    const code = world.codeSentTo(email);

    const stranger = world.visitor({ ip: '10.40.9.11' });
    await askToRegister(stranger, { nationalId: nationalIdOf(), email });
    await askForSignInCode(world.visitor({ ip: '10.40.9.12' }), address('otra'));

    const done = await signInWith(patient, email, code);
    expect(done.statusCode, done.body).toBe(200);
  });

  it('keeps a decoy out of the code check and of the count by its purpose', async () => {
    const { email } = await unregistered();
    await askToRegister(world.visitor({ ip: '10.40.9.13' }), { nationalId: nationalIdOf(), email });

    const rows = await world.inTenant((tx) =>
      tx.execute<{ purpose: string; consumed: boolean }>(
        sql`select purpose, consumed_at is not null as consumed from otp_challenge where email = ${email}`,
      ),
    );

    expect(rows.rows).toEqual([{ purpose: 'portal_decoy', consumed: true }]);
  });
});

describe('R2-4: the tries to use a code are counted per client', () => {
  it('does not let five wrong codes from one client burn the code of the patient', async () => {
    const { email } = await world.patientSession();
    const patient = world.visitor({ ip: '10.41.1.1' });
    expect((await askForSignInCode(patient, email)).statusCode).toBe(200);
    await world.runJobs();
    const code = world.codeSentTo(email);

    const attacker = world.visitor({ ip: '10.41.9.9' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await signInWith(attacker, email, '000000');
      expect(wrong.statusCode).toBe(400);
    }
    // The attacker is out of tries for this code, even with the right one (it would not know it).
    expect((await signInWith(attacker, email, code)).statusCode).toBe(400);

    const done = await signInWith(patient, email, code);
    expect(done.statusCode, done.body).toBe(200);
  });

  it('spends the code after twenty wrong tries from different clients', async () => {
    const { email } = await world.patientSession();
    const patient = world.visitor({ ip: '10.41.1.2' });
    expect((await askForSignInCode(patient, email)).statusCode).toBe(200);
    await world.runJobs();
    const code = world.codeSentTo(email);

    for (let client = 0; client < 4; client += 1) {
      const attacker = world.visitor({ ip: `10.41.8.${String(client + 1)}` });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await signInWith(attacker, email, '000000')).statusCode).toBe(400);
      }
    }

    const late = await signInWith(patient, email, code);
    expect(late.statusCode, late.body).toBe(400);
    expect(problemOf(late).code).toBe('portal_code_invalid');
  });

  it('counts the tries of a registration per client too', async () => {
    const { email, nationalId } = await unregistered();
    const patient = world.visitor({ ip: '10.41.1.3' });
    expect((await askToRegister(patient, { nationalId, email })).statusCode).toBe(200);
    await world.runJobs();
    const code = world.codeSentTo(email);
    const attacker = world.visitor({ ip: '10.41.9.8' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await registerWith(attacker, { nationalId, email, code: '000000' })).statusCode).toBe(
        400,
      );
    }

    const done = await registerWith(patient, { nationalId, email, code });

    expect(done.statusCode, done.body).toBe(200);
  });

  it('limits the codes a client can ask for in an hour, whatever the addresses', async () => {
    const asker = world.visitor({ ip: '10.41.7.7' });
    const answers: number[] = [];
    for (let request = 0; request < 8; request += 1) {
      answers.push((await askForSignInCode(asker, address('desconocido'))).statusCode);
    }

    expect(answers.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(answers.slice(6)).toEqual([429, 429]);
    // Another client is not affected.
    const other = world.visitor({ ip: '10.41.7.8' });
    expect((await askForSignInCode(other, address('otro'))).statusCode).toBe(200);
  });
});
