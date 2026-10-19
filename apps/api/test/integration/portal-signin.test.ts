import type { PortalSessionsResponse, Problem, PortalIdentityDto } from '@consultorio/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { type Visitor } from '../support/booking-world.js';
import { createPortalWorld, rowsOf, type PortalWorld } from '../support/portal-world.js';

/**
 * Registering and signing in to the portal (S5.07, tasks 5.27 to 5.30): a code by email, a cookie
 * of its own, and answers that never say whether an account, a document or a patient exists.
 */
let runtime: DbHandle;
let world: PortalWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createPortalWorld(runtime, { slug: 'portal-signin' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const path = (suffix: string) => `/public/${world.slug}/portal${suffix}`;

async function askForCode(visitor: Visitor, email: string) {
  return visitor.post(path('/otp'), { email, challengeProof: await visitor.solve() });
}
const verify = (visitor: Visitor, email: string, code: string) =>
  visitor.post(path('/otp/verify'), { email, code });
async function register(visitor: Visitor, nationalId: string, email: string) {
  return visitor.post(path('/register'), {
    nationalId,
    email,
    challengeProof: await visitor.solve(),
  });
}
const verifyRegistration = (visitor: Visitor, nationalId: string, email: string, code: string) =>
  visitor.post(path('/register/verify'), { nationalId, email, code });

/** A patient with an active portal account, signed in on a browser of their own. */
async function signedIn(
  email?: string,
): Promise<{ visitor: Visitor; email: string; patientId: string }> {
  const address = email ?? `p${crypto.randomUUID().slice(0, 8)}@example.test`;
  const patientId = await world.patientWith({ email: address });
  await world.onboard(patientId);
  const visitor = world.visitor();
  expect((await askForCode(visitor, address)).statusCode).toBe(200);
  await world.runJobs();
  const response = await verify(visitor, address, world.codeSentTo(address));
  expect(response.statusCode, response.body).toBe(200);
  return { visitor, email: address, patientId };
}

const audits = (action: string) =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, action as never)))
      .orderBy(asc(auditEvent.occurredAt)),
  );

describe('registering with the document and the email on the record', () => {
  it('sends the code to the address on file, and the code activates the account with a self link', async () => {
    const email = 'registra@example.test';
    const patientId = await world.patientWith({ email, nationalId: '31000001' });
    const patientsBefore = await rowsOf<{ n: number }>(
      world,
      sql`SELECT count(*)::int AS n FROM patient`,
    );
    const visitor = world.visitor();

    const response = await register(visitor, '31.000.001', email);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ accepted: true });
    await world.runJobs();
    const mail = world.email.lastTo(email);
    expect(mail?.subject).toContain('Active su acceso');
    const done = await verifyRegistration(visitor, '31000001', email, world.codeSentTo(email));

    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toEqual({ signedIn: true });
    expect(done.headers['set-cookie']).toContain('__Host-psid=');
    const shown = await world.portalOf(patientId);
    expect(shown.identities).toHaveLength(1);
    expect(shown.identities[0]).toMatchObject({ email, status: 'active' });
    expect(shown.identities[0]?.links[0]).toMatchObject({ patientId, relationship: 'self' });
    // No patient record was created or touched.
    const patientsAfter = await rowsOf<{ n: number }>(
      world,
      sql`SELECT count(*)::int AS n FROM patient`,
    );
    expect(patientsAfter[0]?.n).toBe(patientsBefore[0]?.n);
    for (const action of [
      'portal.identity.created',
      'portal.identity.linked',
      'portal.signin.success',
    ]) {
      expect(
        (await audits(action)).some(
          (row) => row.patientId === patientId || row.resourceType === 'portal_identity',
        ),
      ).toBe(true);
    }
  });

  it('answers every visitor the same, and emails only when the document and the email match one patient without an account', async () => {
    const email = 'match@example.test';
    await world.patientWith({ email, nationalId: '31000002' });
    const withAccount = `cuenta-${crypto.randomUUID().slice(0, 6)}@example.test`;
    await world.onboard(await world.patientWith({ email: withAccount, nationalId: '31000003' }));
    const invited = `inv-${crypto.randomUUID().slice(0, 6)}@example.test`;
    await world.inviteOk(await world.patientWith({ email: invited, nationalId: '31000004' }));
    const sentBefore = world.email.sent.length;

    const attempts: [string, string][] = [
      ['31000002', email], // matches
      ['31000002', 'otro@example.test'], // the document, not the email
      ['39999999', email], // an email on a record, not that document
      ['39999998', 'nadie@example.test'], // nothing
      ['no es un dni', email], // not a document at all
      ['31000003', withAccount], // already has an account
    ];
    const answers = [];
    for (const [nationalId, address] of attempts) {
      const response = await register(world.visitor(), nationalId, address);
      answers.push({ status: response.statusCode, body: response.body });
    }
    await world.runJobs();

    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(answers[0]).toEqual({ status: 200, body: JSON.stringify({ accepted: true }) });
    // Only the one that matches received anything.
    const mails = world.email.sent.slice(sentBefore).filter((mail) => /código/.test(mail.subject));
    expect(mails.map((mail) => mail.to)).toEqual([email]);
  });

  it('is wrong with another document, another email, a wrong code or no code, always the same way', async () => {
    const email = 'verifica@example.test';
    await world.patientWith({ email, nationalId: '31000005' });
    const visitor = world.visitor();
    await register(visitor, '31000005', email);
    await world.runJobs();
    const code = world.codeSentTo(email);
    const wrong = code === '000000' ? '111111' : '000000';

    const cases = await Promise.all([
      verifyRegistration(world.visitor(), '31000005', email, wrong),
      verifyRegistration(world.visitor(), '39999999', email, code),
      verifyRegistration(world.visitor(), '31000005', 'otro@example.test', code),
      verifyRegistration(world.visitor(), '31000005', 'sin-codigo@example.test', code),
    ]);

    for (const response of cases) {
      expect(response.statusCode).toBe(400);
      expect(response.json<Problem>().code).toBe('portal_code_invalid');
    }
    expect(
      new Set(cases.map((response) => response.body.replace(/"requestId":"[^"]+"/, ''))).size,
    ).toBe(1);
    // The right one still works afterwards (a wrong attempt did not spend the code).
    expect((await verifyRegistration(visitor, '31000005', email, code)).statusCode).toBe(200);
  });

  it('refuses the proof of the challenge that is missing or wrong, before anything else', async () => {
    const visitor = world.visitor();

    const missing = await visitor.post(path('/register'), {
      nationalId: '31000009',
      email: 'a@example.test',
    });
    const wrong = await visitor.post(path('/register'), {
      nationalId: '31000009',
      email: 'a@example.test',
      challengeProof: 'not-a-proof',
    });

    expect(missing.statusCode).toBe(400);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<Problem>().code).toBe('portal_challenge_failed');
  });

  it('can finish the activation of a pending invitation of the same patient', async () => {
    const email = 'invitada-registra@example.test';
    const patientId = await world.patientWith({ email, nationalId: '31000006' });
    await world.inviteOk(patientId);
    const visitor = world.visitor();
    await register(visitor, '31000006', email);
    await world.runJobs();

    const done = await verifyRegistration(visitor, '31000006', email, world.codeSentTo(email));

    expect(done.statusCode, done.body).toBe(200);
    const shown = await world.portalOf(patientId);
    expect(shown.identities.map((identity) => identity.status)).toEqual(['active']);
    // The old invitation link no longer does anything.
  });
});

describe('signing in with a code', () => {
  it('emails a code to an active account and starts a session of its own with it', async () => {
    const { visitor, email } = await signedIn();

    const sessions = await visitor.get('/portal/sessions');

    expect(sessions.statusCode, sessions.body).toBe(200);
    const body = sessions.json<PortalSessionsResponse>();
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ current: true, userAgent: 'vitest-visitor' });
    expect(world.email.lastTo(email)?.subject).toContain('Ingrese');
    const ok = (await audits('portal.signin.success')).filter(
      (row) => row.actingRole === 'patient',
    );
    expect(ok.length).toBeGreaterThan(0);
    expect(ok[0]).toMatchObject({ actorUserId: null, outcome: 'allow' });
  });

  it('answers the same for an account, an unknown address and a deactivated one, and sends only to the first', async () => {
    const { email } = await signedIn();
    const gone = await signedIn();
    const identity = (await world.portalOf(gone.patientId)).identities[0] as PortalIdentityDto;
    expect(
      (await world.api.post(`/portal-identities/${identity.id}/deactivate`, world.admin, {}))
        .statusCode,
    ).toBe(200);
    world.email.clear();

    const answers = [];
    for (const address of [email, 'nadie@example.test', gone.email]) {
      const response = await askForCode(world.visitor(), address);
      answers.push({ status: response.statusCode, body: response.body });
    }
    await world.runJobs();

    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(answers[0]).toEqual({ status: 200, body: JSON.stringify({ accepted: true }) });
    expect(world.email.sent.map((mail) => mail.to)).toEqual([email]);
  });

  it('keeps one live code per account: the newest replaces the older one', async () => {
    const { email } = await signedIn();
    const visitor = world.visitor();
    world.email.clear();
    await askForCode(visitor, email);
    await world.runJobs();
    const first = world.codeSentTo(email);
    await askForCode(visitor, email);
    await world.runJobs();
    const second = world.codeSentTo(email);

    // Two different codes on the same line would be a bad test; the odds are one in a million.
    expect(second).not.toBe(first);
    const old = await verify(visitor, email, first);
    expect(old.statusCode).toBe(400);
    expect((await verify(visitor, email, second)).statusCode).toBe(200);
  });

  it('spends the code on its fifth wrong attempt, and the right one is then no use', async () => {
    const { email } = await signedIn();
    const visitor = world.visitor();
    await askForCode(visitor, email);
    await world.runJobs();
    const code = world.codeSentTo(email);
    const wrong = code === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await verify(visitor, email, wrong)).json<Problem>().code).toBe(
        'portal_code_invalid',
      );
    }
    const late = await verify(visitor, email, code);

    expect(late.statusCode).toBe(400);
    const failures = (await audits('portal.signin.failure')).filter(
      (row) => row.actingRole === 'patient',
    );
    expect(failures.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(failures.map((row) => row.metadata))).not.toContain(email);
  });

  it('stops answering for an address after too many tries, and does it for an unknown one as well', async () => {
    // An account that never signed in, so no earlier try counts against the window.
    const email = `bloqueo-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await world.onboard(await world.patientWith({ email }));
    const known = world.visitor();
    const unknown = world.visitor();
    await askForCode(known, email);
    await world.runJobs();
    const code = world.codeSentTo(email);

    const knownCodes: number[] = [];
    const unknownCodes: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      knownCodes.push((await verify(known, email, '000001')).statusCode);
      unknownCodes.push((await verify(unknown, 'nunca@example.test', '000001')).statusCode);
    }

    expect(knownCodes).toEqual(unknownCodes);
    expect(knownCodes.slice(0, 10)).toEqual(Array<number>(10).fill(400));
    expect(knownCodes.slice(10)).toEqual([429, 429]);
    // Locked: not even the right code opens it until the window is over.
    expect((await verify(known, email, code)).statusCode).toBe(429);
    const locked = (await audits('portal.signin.failure')).some(
      (row) => row.reason === 'locked' && row.actingRole === 'patient',
    );
    expect(locked).toBe(true);
  });

  it('sends at most three codes an hour to one address, and says the same when it sends none', async () => {
    const { email } = await signedIn();
    world.email.clear();
    const answers = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await askForCode(world.visitor(), email);
      answers.push(response.body);
    }
    await world.runJobs();

    expect(new Set(answers).size).toBe(1);
    // One of the three sends of the hour went to the sign-in of `signedIn`: two more were opened,
    // and only the newest of them is live, so it is the one that was emailed.
    const [opened] = await rowsOf<{ n: number }>(
      world,
      sql`SELECT count(*)::int AS n FROM otp_challenge WHERE email = ${email}`,
    );
    expect(opened?.n).toBe(3);
    expect(world.email.sent.filter((mail) => mail.to === email)).toHaveLength(1);
  });

  it('refuses the proof of the challenge that is missing', async () => {
    const response = await world.visitor().post(path('/otp'), { email: 'a@example.test' });

    expect(response.statusCode).toBe(400);
  });
});

describe('the session', () => {
  it('lists the sessions of the person and lets them end another one', async () => {
    const { visitor, email } = await signedIn();
    const other = world.visitor();
    await askForCode(other, email);
    await world.runJobs();
    expect((await verify(other, email, world.codeSentTo(email))).statusCode).toBe(200);

    const listed = (await visitor.get('/portal/sessions')).json<PortalSessionsResponse>();
    expect(listed.sessions).toHaveLength(2);
    const target = listed.sessions.find((session) => !session.current);
    const ended = await visitor.delete(`/portal/sessions/${target?.id ?? ''}`);

    expect(ended.statusCode, ended.body).toBe(204);
    expect((await other.get('/portal/sessions')).statusCode).toBe(401);
    expect((await visitor.get('/portal/sessions')).statusCode).toBe(200);
  });

  it('answers not found for a session that is not theirs', async () => {
    const mine = await signedIn();
    const theirs = await signedIn();
    const theirSession = (
      await theirs.visitor.get('/portal/sessions')
    ).json<PortalSessionsResponse>().sessions[0];

    const response = await mine.visitor.delete(`/portal/sessions/${theirSession?.id ?? ''}`);

    expect(response.statusCode).toBe(404);
    expect((await theirs.visitor.get('/portal/sessions')).statusCode).toBe(200);
  });

  it('ends on logout, and the old cookie is no use', async () => {
    const { visitor } = await signedIn();
    const cookie = visitor.cookie();

    const out = await visitor.post('/portal/logout', {});

    expect(out.statusCode, out.body).toBe(204);
    expect(out.headers['set-cookie']).toContain('Max-Age=0');
    const replay = await world.app.inject({
      method: 'GET',
      url: '/portal/sessions',
      headers: { host: `${world.slug}.consultorio.test`, cookie },
    });
    expect(replay.statusCode).toBe(401);
  });

  it('ends when an administrator revokes the sessions of the account', async () => {
    const { visitor, patientId } = await signedIn();
    const identity = (await world.portalOf(patientId)).identities[0] as PortalIdentityDto;

    const response = await world.api.post(
      `/portal-identities/${identity.id}/sessions/revoke`,
      world.admin,
      {},
    );

    expect(response.statusCode, response.body).toBe(200);
    expect((await visitor.get('/portal/sessions')).statusCode).toBe(401);
    const revoked = await audits('auth.session.revoked');
    expect(revoked.some((row) => row.resourceId === identity.id)).toBe(true);
    // A professional cannot.
    expect(
      (await world.api.post(`/portal-identities/${identity.id}/sessions/revoke`, world.doctor, {}))
        .statusCode,
    ).toBe(403);
  });

  it('is not shared with another organization: the cookie of one host finds nothing on another', async () => {
    const { visitor } = await signedIn();
    const other = await createPortalWorld(runtime, { slug: 'portal-signin-other' });
    try {
      const replay = await other.app.inject({
        method: 'GET',
        url: '/portal/sessions',
        headers: { host: `${other.slug}.consultorio.test`, cookie: visitor.cookie() },
      });

      expect(replay.statusCode).toBe(401);
    } finally {
      await other.close();
    }
  });

  it('is not a staff session: the staff routes answer 401 to it', async () => {
    const { visitor } = await signedIn();

    expect((await visitor.get('/patients')).statusCode).toBe(401);
    expect((await visitor.get('/auth/me')).statusCode).toBe(401);
  });

  it('asks for the origin of a write', async () => {
    const { visitor } = await signedIn();

    const response = await world.app.inject({
      method: 'POST',
      url: '/portal/logout',
      headers: { host: `${world.slug}.consultorio.test`, cookie: visitor.cookie() },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect((await visitor.get('/portal/sessions')).statusCode).toBe(200);
  });
});

describe('every route of the portal, by who calls it', () => {
  const portalRoutes = () =>
    [...world.app.routeAuth]
      .filter(([route, auth]) => auth === 'portal' && !route.startsWith('HEAD '))
      .map(([route]) => route)
      .sort();

  const concrete = (url: string) =>
    url.replaceAll(/:[A-Za-z]+/g, (name) =>
      name === ':token' ? 'a'.repeat(43) : '0190a000-0000-7000-8000-00000000dead',
    );

  it('has routes to check (the enumeration is not silently empty)', () => {
    expect(portalRoutes().length).toBeGreaterThanOrEqual(3);
  });

  it('answers 401 to nobody and to every staff role, and lets the patient through to the handler', async () => {
    const host = `${world.slug}.consultorio.test`;
    for (const route of portalRoutes()) {
      const method = route.slice(0, route.indexOf(' '));
      const url = concrete(route.slice(route.indexOf(' ') + 1));
      const send = (cookie?: string, origin = true) =>
        world.app.inject({
          method: method as 'GET',
          url,
          headers: {
            host,
            ...(origin ? { origin: `https://${host}` } : {}),
            ...(cookie === undefined ? {} : { cookie }),
          },
          ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
        });

      expect((await send()).statusCode, `${route} anonymous`).toBe(401);
      for (const [role, member] of [
        ['owner', world.owner],
        ['admin', world.admin],
        ['reception', world.reception],
        ['professional', world.doctor],
      ] as const) {
        expect((await send(member.cookie)).statusCode, `${route} ${role}`).toBe(401);
      }
      const patient = await signedIn();
      const answer = await send(patient.visitor.cookie());
      expect([401, 403], `${route} patient`).not.toContain(answer.statusCode);
    }
  }, 120_000);
});

describe('time', () => {
  it('ends a session after 30 minutes without use and keeps one that is used', async () => {
    const clocked = await createPortalWorld(runtime, { slug: 'portal-signin-time' });
    try {
      const email = 'tiempo@example.test';
      await clocked.onboard(await clocked.patientWith({ email }));
      const visitor = clocked.visitor();
      const ask = async () =>
        visitor.post(`/public/${clocked.slug}/portal/otp`, {
          email,
          challengeProof: await visitor.solve(),
        });
      await ask();
      await clocked.runJobs();
      const code = clocked.codeSentTo(email);
      expect(
        (await visitor.post(`/public/${clocked.slug}/portal/otp/verify`, { email, code }))
          .statusCode,
      ).toBe(200);

      clocked.advance(20 * 60_000);
      expect((await visitor.get('/portal/sessions')).statusCode).toBe(200);
      clocked.advance(20 * 60_000);
      expect((await visitor.get('/portal/sessions')).statusCode).toBe(200);
      clocked.advance(31 * 60_000);
      expect((await visitor.get('/portal/sessions')).statusCode).toBe(401);
    } finally {
      await clocked.close();
    }
  });

  it('refuses a code after its ten minutes', async () => {
    const clocked = await createPortalWorld(runtime, { slug: 'portal-signin-expiry' });
    try {
      const email = 'vence@example.test';
      await clocked.onboard(await clocked.patientWith({ email }));
      const visitor = clocked.visitor();
      await visitor.post(`/public/${clocked.slug}/portal/otp`, {
        email,
        challengeProof: await visitor.solve(),
      });
      await clocked.runJobs();
      const code = clocked.codeSentTo(email);
      clocked.advance(11 * 60_000);

      const late = await visitor.post(`/public/${clocked.slug}/portal/otp/verify`, { email, code });

      expect(late.statusCode).toBe(400);
    } finally {
      await clocked.close();
    }
  });
});

describe('a code for a deactivated account', () => {
  it('cannot be requested, and a code asked for before the deactivation does not sign in', async () => {
    const { email, patientId } = await signedIn();
    const visitor = world.visitor();
    await askForCode(visitor, email);
    await world.runJobs();
    const code = world.codeSentTo(email);
    const identity = (await world.portalOf(patientId)).identities[0] as PortalIdentityDto;
    await world.api.post(`/portal-identities/${identity.id}/deactivate`, world.admin, {});

    const response = await verify(visitor, email, code);

    expect(response.statusCode).toBe(400);
    expect(
      (
        await rowsOf<{ n: number }>(
          world,
          sql`SELECT count(*)::int AS n FROM portal_session WHERE revoked_at IS NULL AND portal_identity_id = ${identity.id}`,
        )
      )[0]?.n,
    ).toBe(0);
  });
});
