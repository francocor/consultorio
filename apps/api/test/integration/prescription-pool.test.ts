import type { PrescriptionDto } from '@consultorio/contracts';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import * as schema from '../../src/db/schema/index.js';
import type { DbHandle } from '../../src/platform/db/pool.js';
import { createErxWorld, type ErxWorld } from '../support/erx-world.js';

/**
 * JD-S5 R2-8 and R2-12: the requests that talk to the provider (a retry, a cancellation, a manual
 * registration) hold no connection while they wait for it. The pool here has TWO connections; the
 * provider is blocked; a request that needs the database is still served, because nothing is waiting
 * for a connection while holding one.
 */
let pool: pg.Pool;
let runtime: DbHandle;
let world: ErxWorld;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: inject('runtimeUrl'), max: 2 });
  pool.on('error', () => undefined);
  runtime = { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
  world = await createErxWorld(runtime, { slug: 'prescription-pool' });
});

afterAll(async () => {
  await world.stop();
  await runtime.close();
});

const deferred = () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
};

/** A prescription the provider could not take, so it waits and may be sent, cancelled or registered. */
async function pending() {
  const prescriber = await world.verifiedProfessional();
  const patientId = await world.patientWithDocument([prescriber]);
  world.provider.setMode('down');
  const made = (await world.issue(prescriber, { patientId })).json<PrescriptionDto>();
  world.provider.setMode('ok');
  expect(made.status).toBe('pending_submission');
  return { prescriber, made };
}

/** Answers in time, or fails the test: a pool that is exhausted never answers. */
async function served<T>(request: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const lost = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('the request was not served: the pool is exhausted'));
    }, 8_000);
  });
  try {
    return await Promise.race([request, lost]);
  } finally {
    clearTimeout(timer);
  }
}

describe('a pool of two connections and a provider that does not answer', () => {
  it('serves a third request while two cancellations and a retry wait for the provider', async () => {
    const [one, two, three] = [await pending(), await pending(), await pending()];
    const keyOf = async (id: string) => (await world.rowOf(id))['idempotency_key'] as string;
    const [keyOne, keyTwo, keyThree] = [
      await keyOf(one.made.id),
      await keyOf(two.made.id),
      await keyOf(three.made.id),
    ];
    const slow = deferred();
    const asked = world.provider.findByKey.bind(world.provider);
    const issued = world.provider.issue.bind(world.provider);
    let inside = 0;
    // The provider does not answer the question about two keys, nor the request to issue the third.
    world.provider.findByKey = async (key, signal) => {
      if (key === keyOne || key === keyTwo) {
        inside += 1;
        await slow.gate;
      }
      return asked(key, signal);
    };
    world.provider.issue = async (request, key, signal) => {
      if (key === keyThree) {
        inside += 1;
        await slow.gate;
      }
      return issued(request, key, signal);
    };
    try {
      const cancels = [one, two].map(({ prescriber, made }) =>
        world.api.post(`/prescriptions/${made.id}/cancel`, prescriber.session, {
          reason: 'Ya no hace falta',
        }),
      );
      const retry = world.api.post(
        `/prescriptions/${three.made.id}/retry`,
        three.prescriber.session,
      );
      while (inside < 3) await new Promise((resolve) => setTimeout(resolve, 20));

      // The connections of the pool are free: this request is served now.
      const read = await served(
        world.api.get(`/prescriptions/${one.made.id}`, one.prescriber.session),
      );
      expect(read.statusCode, read.body).toBe(200);
      const list = await served(world.api.get('/prescriptions', one.prescriber.session));
      expect(list.statusCode, list.body).toBe(200);

      slow.release();
      const answers = await Promise.all([...cancels, retry]);
      for (const answer of answers) expect(answer.statusCode, answer.body).toBe(200);
      expect(answers.map((answer) => answer.json<PrescriptionDto>().status)).toEqual([
        'cancelled',
        'cancelled',
        'issued',
      ]);
    } finally {
      slow.release();
      world.provider.findByKey = asked;
      world.provider.issue = issued;
    }
  }, 60_000);

  it('serves a request while a manual registration waits for the provider', async () => {
    const one = await pending();
    const two = await pending();
    const keyOne = (await world.rowOf(one.made.id))['idempotency_key'] as string;
    const keyTwo = (await world.rowOf(two.made.id))['idempotency_key'] as string;
    const slow = deferred();
    const asked = world.provider.findByKey.bind(world.provider);
    let inside = 0;
    world.provider.findByKey = async (key, signal) => {
      if (key === keyOne || key === keyTwo) {
        inside += 1;
        await slow.gate;
      }
      return asked(key, signal);
    };
    try {
      const manual = [one, two].map(({ prescriber, made }, index) =>
        world.api.post(`/prescriptions/${made.id}/register-manual`, prescriber.session, {
          identifier: `RX-SITIO-POOL-${String(index)}`,
        }),
      );
      while (inside < 2) await new Promise((resolve) => setTimeout(resolve, 20));

      const read = await served(
        world.api.get(`/prescriptions/${one.made.id}`, one.prescriber.session),
      );
      expect(read.statusCode, read.body).toBe(200);

      slow.release();
      for (const answer of await Promise.all(manual)) {
        expect(answer.statusCode, answer.body).toBe(200);
        expect(answer.json<PrescriptionDto>().status).toBe('issued');
      }
    } finally {
      slow.release();
      world.provider.findByKey = asked;
    }
  }, 60_000);
});
