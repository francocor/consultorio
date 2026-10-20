import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { countQueries, shapeOf } from '../support/security.js';
import { PASSWORD, createSignupWorld, type SignupWorld } from '../support/signup-world.js';

/**
 * The signup is a public form that makes organizations, which makes it a target. Its answers must
 * not tell a stranger whether a name or an address is already in use, it must cost a flood more
 * than it costs us, and it must keep what it learns out of the logs (tenant-onboarding, "Signup
 * abuse protection"; F11).
 */
let runtime: DbHandle;
let world: SignupWorld;

beforeAll(async () => {
  expect(inject('adminUrl')).toBeTruthy();
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createSignupWorld(runtime);
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

type Form = ReturnType<SignupWorld['form']>;

/** One signup, counted: the statements the application sent from the request until the work after the answer ended. */
async function measuredSignUp(form: Form) {
  const ip = world.ip();
  const challengeProof = await world.solve({ ip });
  let response!: Awaited<ReturnType<SignupWorld['platformPost']>>;
  const statements = await countQueries(async () => {
    response = await world.platformPost('/public/signup', { ...form, challengeProof }, { ip });
    await world.idle();
  });
  return { response, statements };
}

async function measuredResend(address: string) {
  const ip = world.ip();
  const challengeProof = await world.solve({ ip });
  let response!: Awaited<ReturnType<SignupWorld['platformPost']>>;
  const statements = await countQueries(async () => {
    response = await world.platformPost(
      '/public/signup/resend',
      { email: address, challengeProof },
      { ip },
    );
    await world.idle();
  });
  return { response, statements };
}

/** An address that has an account (a verified owner). */
async function accountAddress(): Promise<string> {
  const { form } = await world.signUp();
  await world.idle();
  const link = world.linkTo(form.email);
  const verified = await world.tenantPost(link.slug, '/public/signup/verify', {
    token: link.token,
  });
  expect(verified.statusCode, verified.body).toBe(200);
  return form.email;
}

/** An address with a signup that still waits for its link. */
async function pendingAddress(): Promise<string> {
  const { form } = await world.signUp();
  await world.idle();
  return form.email;
}

describe('the answer of a signup does not depend on what exists', () => {
  it('is the same for a new address, one with a signup waiting, one with an account, and a name already used', async () => {
    const taken = world.form();
    await world.signUp({ organizationName: taken.organizationName });
    const account = await accountAddress();
    const pending = await pendingAddress();

    const answers = [
      await measuredSignUp(world.form()),
      await measuredSignUp(world.form({ email: pending })),
      await measuredSignUp(world.form({ email: account })),
      await measuredSignUp(world.form({ organizationName: taken.organizationName })),
    ];

    for (const { response } of answers) expect(response.statusCode, response.body).toBe(200);
    expect(new Set(answers.map(({ response }) => shapeOf(response))).size).toBe(1);
    expect(answers[0]?.response.json()).toEqual({ accepted: true });
  });

  it('sends the database the same number of statements, from the request to the end of the work after the answer', async () => {
    const account = await accountAddress();
    const pending = await pendingAddress();
    const taken = world.form();
    await world.signUp({ organizationName: taken.organizationName });
    // What the signups above still do after their answers must not fall in the window measured.
    await world.idle();

    const fresh = await measuredSignUp(world.form());
    const waiting = await measuredSignUp(world.form({ email: pending }));
    const holder = await measuredSignUp(world.form({ email: account }));
    const sameName = await measuredSignUp(world.form({ organizationName: taken.organizationName }));

    expect(waiting.statements).toBe(fresh.statements);
    expect(holder.statements).toBe(fresh.statements);
    expect(sameName.statements).toBe(fresh.statements);
  });

  it('does the same work asking for a new link, whether the address has a signup, an account or nothing', async () => {
    const account = await accountAddress();
    const pending = await pendingAddress();
    const nobody = `nadie-${crypto.randomUUID().slice(0, 6)}@example.test`;

    const known = await measuredResend(pending);
    const holder = await measuredResend(account);
    const stranger = await measuredResend(nobody);

    expect(new Set([known, holder, stranger].map(({ response }) => shapeOf(response))).size).toBe(
      1,
    );
    expect(holder.statements).toBe(known.statements);
    expect(stranger.statements).toBe(known.statements);
  });

  it('refuses the same way when the address is throttled, whatever it is', async () => {
    const account = await accountAddress();
    const nobody = `nadie-${crypto.randomUUID().slice(0, 6)}@example.test`;
    const refusals = [];
    for (const address of [account, nobody]) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const { response } = await measuredResend(address);
        if (attempt === 3) refusals.push(response);
      }
    }

    expect(refusals.map((response) => response.statusCode)).toEqual([429, 429]);
    expect(new Set(refusals.map((response) => shapeOf(response))).size).toBe(1);
  });

  it('says nothing of the address or the name in what it answers or sends to somebody else', async () => {
    const account = await accountAddress();
    world.email.clear();

    const form = world.form({ email: account });
    const { response } = await measuredSignUp(form);

    expect(response.body).not.toContain(account);
    expect(response.body).not.toContain(form.organizationName);
    // The only mail goes to the holder, and it names neither the organization asked for nor the owner.
    expect(world.email.sent.map((mail) => mail.to)).toEqual([account]);
    expect(JSON.stringify(world.email.sent)).not.toContain(form.organizationName);
    expect(JSON.stringify(world.email.sent)).not.toContain(form.ownerName);
  });
});

describe('what the signup keeps out of the logs', () => {
  it('writes no address, name, password or link in the log, on success and on every refusal', async () => {
    const good = world.form({
      ownerName: 'Zulema Quispe',
      organizationName: 'Clínica Zulema Norte',
    });
    const weak = world.form({ ownerName: 'Ramiro Ibarra', password: 'password1234' });
    const noTerms = world.form({ ownerName: 'Edelmira Paz', acceptTerms: false });
    const holder = await accountAddress();

    await measuredSignUp(good);
    await measuredSignUp(weak);
    await measuredSignUp(noTerms);
    await measuredSignUp(world.form({ email: holder, ownerName: 'Fulgencio Roa' }));
    world.email.down = true;
    const down = world.form({ ownerName: 'Hermenegildo Sosa' });
    await measuredSignUp(down);
    world.email.down = false;
    const link = world.linkTo(good.email);
    await world.tenantPost(link.slug, '/public/signup/verify', { token: link.token });
    await world.tenantPost(link.slug, '/public/signup/verify', { token: link.token });

    const log = world.logs();
    expect(log.length).toBeGreaterThan(0);
    for (const secret of [
      good.email,
      weak.email,
      noTerms.email,
      holder,
      down.email,
      good.ownerName,
      weak.ownerName,
      noTerms.ownerName,
      down.ownerName,
      good.organizationName,
      PASSWORD,
      'password1234',
      link.token,
    ]) {
      expect(log, secret).not.toContain(secret);
    }
  });
});

describe('who may ask for what, and from where', () => {
  it('serves the challenge on the platform host and on an unverified organization, and on no other host', async () => {
    const { form } = await world.signUp();
    await world.idle();
    const link = world.linkTo(form.email);

    const platform = await world.platformGet('/public/signup/challenge');
    const waiting = await world.tenantGet(link.slug, '/public/signup/challenge');
    await world.tenantPost(link.slug, '/public/signup/verify', { token: link.token });
    const active = await world.tenantGet(link.slug, '/public/signup/challenge');

    expect(platform.statusCode).toBe(200);
    expect(waiting.statusCode).toBe(200);
    expect(active.statusCode).toBe(404);
    expect(platform.headers['cache-control']).toBe('no-store');
  });

  it('limits each route per client with a limit of its own', () => {
    for (const route of [
      'GET /public/signup/challenge',
      'POST /public/signup',
      'POST /public/signup/resend',
      'POST /public/signup/renew',
      'POST /public/signup/verify',
    ]) {
      expect(world.app.routeDeclarations.get(route)?.rateLimited, route).toBe(true);
    }
  });

  it('answers a request of a client that hammers the verification with the limit, before it looks at the token', async () => {
    const { form } = await world.signUp();
    await world.idle();
    const link = world.linkTo(form.email);
    const ip = world.ip();

    const statuses = [];
    for (let attempt = 0; attempt < 22; attempt += 1) {
      statuses.push(
        (
          await world.tenantPost(
            link.slug,
            '/public/signup/verify',
            { token: 'x'.repeat(43) },
            { ip },
          )
        ).statusCode,
      );
    }

    expect(statuses.slice(0, 20).every((status) => status === 400)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });
});
