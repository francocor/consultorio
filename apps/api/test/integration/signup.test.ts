import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { exportOnboarding } from '../../src/modules/onboarding/application/export-contributor.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { SYSTEM_USER_ID, createWithTenant } from '../../src/platform/db/tenant-context.js';
import { PASSWORD, createSignupWorld, type SignupWorld } from '../support/signup-world.js';

/**
 * Self-service signup (S6.02, tasks 6.10 and 6.11): a visitor asks for an organization, it exists as
 * `unverified` with no account, and it becomes active only through the emailed link. The trial door
 * is a double that records the call: the real one is the subscriptions track (S6.01).
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

const audits = async (tenantId: string) =>
  (
    await world.admin.query<{
      action: string;
      outcome: string;
      actor_user_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      'SELECT action, outcome, actor_user_id, metadata FROM audit_event WHERE tenant_id = $1 ORDER BY occurred_at, id',
      [tenantId],
    )
  ).rows;

const count = async (sqlText: string, params: unknown[] = []) =>
  Number((await world.admin.query<{ n: string }>(sqlText, params)).rows[0]?.n ?? -1);

describe('signing up', () => {
  it('creates an unverified organization with no account, and emails the link to the address given', async () => {
    const { response, form } = await world.signUp();
    await world.idle();

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ accepted: true });
    const link = world.linkTo(form.email);
    const created = await world.tenantOf(link.slug);
    expect(created?.status).toBe('unverified');
    // The link points at the host of the new organization, never at a host the request named.
    expect(link.url.startsWith(`https://${link.slug}.consultorio.test/signup/verify?token=`)).toBe(
      true,
    );
    // No account exists yet: the address is not taken by somebody who has not proved it is theirs.
    expect(
      await count('SELECT count(*) AS n FROM user_account WHERE email = $1', [form.email]),
    ).toBe(0);
    expect(
      await count('SELECT count(*) AS n FROM membership WHERE tenant_id = $1', [created?.id]),
    ).toBe(0);
    // Nothing the visitor chose is kept: no password and no acceptance (JD-S6 R1-S6-3).
    const pending = await world.admin.query<Record<string, unknown>>(
      'SELECT * FROM signup_pending WHERE tenant_id = $1',
      [created?.id],
    );
    expect(pending.rows[0]).toMatchObject({ owner_name: 'Ana Pérez', send_attempts: 1 });
    expect(Object.keys(pending.rows[0] ?? {})).not.toEqual(
      expect.arrayContaining(['password_hash']),
    );
    expect(JSON.stringify(pending.rows[0])).not.toContain(PASSWORD);
    expect(pending.rows[0]?.['verification_sent_at']).not.toBeNull();
    expect(
      await count('SELECT count(*) AS n FROM terms_acceptance WHERE tenant_id = $1', [created?.id]),
    ).toBe(0);
    const mail = world.email.lastTo(form.email);
    expect(mail?.subject).toBe('Confirme su correo para activar su organización');
    expect(mail?.text).toContain(form.organizationName);
    expect(mail?.tenant).toEqual({ id: created?.id, isDemo: false });
  });

  it("records the signup in the organization's trail, with no acceptance yet and no personal data", async () => {
    const { form } = await world.signUp();
    await world.idle();

    const created = await world.tenantOf(world.linkTo(form.email).slug);
    const trail = await audits(created?.id ?? '');

    // The acceptance is recorded when the owner gives it, on the verification page.
    expect(trail.map((row) => row.action)).toEqual(['signup.created']);
    expect(trail.every((row) => row.outcome === 'allow' && row.actor_user_id === null)).toBe(true);
    expect(JSON.stringify(trail)).not.toContain(form.email);
    expect(JSON.stringify(trail)).not.toContain(form.ownerName);
  });

  it('refuses a form that carries a password or an acceptance: those are given at verification (JD-S6 R1-S6-3)', async () => {
    const before = await count('SELECT count(*) AS n FROM tenant');
    const ip = world.ip();
    for (const extra of [
      { password: PASSWORD },
      { acceptTerms: true },
      { acceptDataProcessing: true },
    ]) {
      const form = world.form();
      const response = await world.platformPost(
        '/public/signup',
        {
          organizationName: form.organizationName,
          ownerName: form.ownerName,
          email: form.email,
          challengeProof: await world.solve({ ip }),
          ...extra,
        },
        { ip },
      );

      expect(response.statusCode, response.body).toBe(400);
      expect(world.email.lastTo(form.email)).toBeUndefined();
    }
    expect(await count('SELECT count(*) AS n FROM tenant')).toBe(before);
  });

  it('refuses a name with a line break or a control character, and creates nothing (JD-S6 R1-S6-10)', async () => {
    const before = await count('SELECT count(*) AS n FROM tenant');
    for (const patch of [
      { organizationName: 'Centro\nBcc: victima@example.test' },
      { ownerName: 'Ana\r\nSubject: urgente' },
      { ownerName: 'Ana\u0000' },
    ]) {
      const { response, form } = await world.signUp(patch);

      expect(response.statusCode, response.body).toBe(400);
      expect(world.email.lastTo(form.email)).toBeUndefined();
    }
    expect(await count('SELECT count(*) AS n FROM tenant')).toBe(before);
  });

  it('refuses a failed challenge and creates no organization, no account and no email', async () => {
    const before = await count('SELECT count(*) AS n FROM tenant');
    const form = world.form();

    const ip = world.ip();
    const missing = await world.platformPost('/public/signup', world.signupBody(form, 'nope'));
    const proof = await world.solve({ ip });
    const first = await world.platformPost('/public/signup', world.signupBody(form, proof), { ip });
    const replayed = await world.platformPost(
      '/public/signup',
      world.signupBody(world.form(), proof),
      { ip },
    );

    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'signup_challenge_failed' });
    expect(first.statusCode).toBe(200);
    // A proof works once.
    expect(replayed.statusCode).toBe(400);
    expect(replayed.json()).toMatchObject({ code: 'signup_challenge_failed' });
    await world.idle();
    expect(await count('SELECT count(*) AS n FROM tenant')).toBe(before + 1);
  });

  it('never lets the visitor choose the address or the state of the organization', async () => {
    const ip = world.ip();
    const response = await world.platformPost(
      '/public/signup',
      {
        ...world.signupBody(world.form(), await world.solve({ ip })),
        slug: 'mi-centro',
        status: 'active',
      },
      { ip },
    );

    expect(response.statusCode).toBe(400);
  });

  it('exists on the platform host only', async () => {
    const { form } = { form: world.form() };
    const { form: other } = await world.signUp();
    await world.idle();
    const slug = world.linkTo(other.email).slug;

    const onOrganization = await world.tenantPost(slug, '/public/signup', {
      ...form,
      challengeProof: 'x',
    });
    // Whatever is sent: the host is looked at before the body, so a malformed one gets the same 404.
    const malformed = await world.tenantPost(slug, '/public/signup', {});
    const resend = await world.tenantPost(slug, '/public/signup/resend', {});

    expect(onOrganization.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(resend.statusCode).toBe(404);
  });
});

describe('the address of the organization', () => {
  it('is generated from the name, and the same name twice gets a distinct address with a random suffix', async () => {
    const name = `Centro Salud Gemelo ${crypto.randomUUID().slice(0, 4)}`;

    const first = await world.signUp({ organizationName: name });
    const second = await world.signUp({ organizationName: name });
    await world.idle();

    expect(first.response.statusCode).toBe(200);
    expect(second.response.statusCode).toBe(200);
    // The two answers are the same.
    expect(second.response.body).toBe(first.response.body);
    const slugs = [first.form, second.form].map((form) => world.linkTo(form.email).slug);
    expect(slugs[0]).toMatch(/^centro-salud-gemelo-[a-z0-9]{4}$/);
    expect(slugs[1]).toMatch(/^centro-salud-gemelo-[a-z0-9]{4}-[0-9a-f]{4}$/);
    expect(new Set(slugs).size).toBe(2);
  });

  it('never is a word the platform keeps for itself', async () => {
    const cases: [string, string][] = [
      ['Admin', 'admin-org'],
      ['Platform', 'platform-org'],
      ['www', 'www-org'],
      ['Mailpit', 'mailpit-org'],
      ['Soporte', 'soporte-org'],
    ];
    for (const [name, expected] of cases) {
      const { form, response } = await world.signUp({ organizationName: name });
      await world.idle();

      expect(response.statusCode, name).toBe(200);
      const slug = world.linkTo(form.email).slug;
      // Another test may hold the plain one: a suffix after the expected word is just as safe.
      expect(slug.startsWith(expected), `${name} -> ${slug}`).toBe(true);
    }
  });
});

describe('an address that already means something', () => {
  it('gets the same answer for an address that has an account, and its holder is told, with no link', async () => {
    const { form: owner } = await world.signUp();
    await world.idle();
    const link = world.linkTo(owner.email);
    expect((await world.verify(link)).statusCode).toBe(200);
    world.email.clear();
    const organizations = await count('SELECT count(*) AS n FROM tenant');

    const again = await world.signUp({ email: owner.email, organizationName: 'Otra Organización' });
    await world.idle();

    expect(again.response.statusCode, again.response.body).toBe(200);
    expect(again.response.json()).toEqual({ accepted: true });
    // Nothing was created.
    expect(await count('SELECT count(*) AS n FROM tenant')).toBe(organizations);
    // The holder got a notice that opens nothing and links nowhere.
    const mail = world.email.lastTo(owner.email);
    expect(mail?.subject).toBe('Alguien pidió crear una organización con su correo');
    expect(mail?.text).not.toMatch(/https?:\/\//);
    expect(world.email.sent).toHaveLength(1);
  });

  it('keeps one signup per address waiting, and asking again does not touch the live link (JD-S6 R1-S6-3)', async () => {
    const { form } = await world.signUp();
    await world.idle();
    const live = world.linkTo(form.email);
    const organizations = await count('SELECT count(*) AS n FROM tenant');
    const sent = world.email.sent.length;

    // A stranger who types the same address again must not be able to spend or replace the link
    // of the person who will open it.
    const again = await world.signUp({ email: form.email, organizationName: 'No Importa' });
    await world.idle();

    expect(again.response.statusCode).toBe(200);
    expect(again.response.json()).toEqual({ accepted: true });
    expect(await count('SELECT count(*) AS n FROM tenant')).toBe(organizations);
    expect(world.email.sent.length).toBe(sent);
    expect(world.linkTo(form.email).token).toBe(live.token);
    expect((await world.verify(live)).statusCode).toBe(200);
  });
});

describe('throttling', () => {
  it('stops a client that signs up in a burst, with a generic message', async () => {
    const ip = world.ip();
    const answers = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      answers.push((await world.signUp({}, { ip })).response);
    }
    await world.idle();

    expect(answers.slice(0, 5).map((response) => response.statusCode)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    for (const response of answers.slice(5)) {
      expect(response.statusCode, response.body).toBe(429);
      expect(response.json()).toMatchObject({ code: 'rate_limited' });
    }
  });

  it('allows three emails an hour to one address, whatever happens behind it', async () => {
    const address = `inundado-${crypto.randomUUID().slice(0, 6)}@example.test`;
    const statuses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await world.signUp({ email: address })).response.statusCode);
    }
    await world.idle();

    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    // Only the first one sends: a repeated signup for a waiting address sends nothing.
    expect(world.email.sent.filter((mail) => mail.to === address)).toHaveLength(1);
  });

  it('counts the aliases of one mailbox as one address (JD-S6 R1-A-T6)', async () => {
    const stem = `alias-${crypto.randomUUID().slice(0, 6)}`;
    const statuses = [];
    for (const local of [stem, `${stem}+a`, `${stem}+b`, `${stem}+c`, `${stem}+d`]) {
      statuses.push((await world.signUp({ email: `${local}@example.test` })).response.statusCode);
    }
    await world.idle();

    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });
});

describe('when the email provider is down', () => {
  it('keeps the signup and sends the link when the retry pass finds the provider back', async () => {
    world.email.down = true;
    const { response, form } = await world.signUp();
    await world.idle();
    world.email.down = false;

    expect(response.statusCode, response.body).toBe(200);
    expect(world.email.lastTo(form.email)).toBeUndefined();
    const stored = await world.admin.query<{
      id: string;
      verification_sent_at: Date | null;
      send_attempts: number;
    }>(
      `SELECT t.id, p.verification_sent_at, p.send_attempts
         FROM signup_pending p JOIN tenant t ON t.id = p.tenant_id WHERE p.owner_email = $1`,
      [form.email],
    );
    expect(stored.rows[0]).toMatchObject({ verification_sent_at: null, send_attempts: 1 });

    // Before the backoff of the first attempt this signup is not retried (the pass is global: other
    // files leave signups of their own in the database, so what is checked is this address); after
    // it, the pass sends it.
    await world.worker.retryVerifications();
    expect(world.email.lastTo(form.email)).toBeUndefined();
    await world.admin.query(
      `UPDATE signup_pending SET last_send_attempt_at = now() - interval '5 minutes' WHERE owner_email = $1`,
      [form.email],
    );
    expect(await world.worker.retryVerifications()).toBeGreaterThanOrEqual(1);

    const link = world.linkTo(form.email);
    expect((await world.verify(link)).statusCode).toBe(200);
  });

  it('gives up on its own after five attempts, and a visitor can still ask for a new link', async () => {
    world.email.down = true;
    const { form } = await world.signUp();
    await world.idle();
    await world.admin.query(
      `UPDATE signup_pending SET send_attempts = 5, last_send_attempt_at = now() - interval '1 day' WHERE owner_email = $1`,
      [form.email],
    );

    // The provider is back, and still the pass does not try this signup again: it used its attempts.
    world.email.down = false;
    await world.worker.retryVerifications();
    expect(world.email.lastTo(form.email)).toBeUndefined();
    const resent = await world.resend(form.email);
    await world.idle();

    expect(resent.statusCode, resent.body).toBe(200);
    expect(world.email.lastTo(form.email)?.subject).toBe(
      'Confirme su correo para activar su organización',
    );
  });
});

describe('asking for a new link', () => {
  it('sends it from the platform host with the address of the signup, and says the same for an unknown address', async () => {
    const { form } = await world.signUp();
    await world.idle();
    const first = world.linkTo(form.email);
    const unknown = `nadie-${crypto.randomUUID().slice(0, 6)}@example.test`;
    const sentBefore = world.email.sent.length;

    const known = await world.resend(form.email);
    const stranger = await world.resend(unknown);
    await world.idle();

    expect(known.statusCode).toBe(200);
    expect(stranger.statusCode).toBe(200);
    expect(stranger.body).toBe(known.body);
    expect(world.email.sent.length).toBe(sentBefore + 1);
    expect(world.email.lastTo(unknown)).toBeUndefined();
    expect(world.linkTo(form.email).token).not.toBe(first.token);
  });

  it('sends it from the page of the link itself, which names nobody', async () => {
    const { form } = await world.signUp();
    await world.idle();
    const first = world.linkTo(form.email);

    const renewed = await world.renew(first.slug);
    await world.idle();

    expect(renewed.statusCode, renewed.body).toBe(200);
    expect(renewed.json()).toEqual({ accepted: true });
    expect(world.linkTo(form.email).token).not.toBe(first.token);
  });

  it('is not served by the host of an organization that is already active', async () => {
    const { form } = await world.signUp();
    await world.idle();
    const link = world.linkTo(form.email);
    await world.verify(link);

    const renewed = await world.tenantPost(link.slug, '/public/signup/renew', {
      challengeProof: 'x',
    });

    expect(renewed.statusCode).toBe(404);
  });
});

describe('verifying the address', () => {
  it('activates the organization, makes the owner, starts the trial and signs the owner in', async () => {
    const { form } = await world.signUp({ ownerName: 'Lucía Méndez' });
    await world.idle();
    const link = world.linkTo(form.email);
    const created = await world.tenantOf(link.slug);

    const response = await world.verify(link);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ verified: true });
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toMatch(
      /^__Host-sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Secure/,
    );
    expect((await world.tenantOf(link.slug))?.status).toBe('active');
    expect(world.trial.calls).toContain(created?.id);
    // The account exists now, with the password the owner chose at the link, and is its only member.
    const members = await world.admin.query<{
      roles: string[];
      display_name: string;
      email: string;
    }>(
      `SELECT m.roles, m.display_name, u.email FROM membership m JOIN user_account u ON u.id = m.user_id WHERE m.tenant_id = $1`,
      [created?.id],
    );
    expect(members.rows).toEqual([
      { roles: ['owner'], display_name: 'Lucía Méndez', email: form.email },
    ]);
    const pending = await world.admin.query<{ verified_at: Date | null }>(
      'SELECT verified_at FROM signup_pending WHERE tenant_id = $1',
      [created?.id],
    );
    expect(pending.rows[0]?.verified_at).not.toBeNull();
    // The versions accepted, with the instant of the verification and the owner's identity.
    const accepted = await world.admin.query<{
      terms_version: number;
      data_processing_version: number;
      accepted_at: Date;
      user_id: string;
    }>(
      'SELECT terms_version, data_processing_version, accepted_at, user_id FROM terms_acceptance WHERE tenant_id = $1',
      [created?.id],
    );
    expect(accepted.rows).toHaveLength(1);
    expect(accepted.rows[0]).toMatchObject({ terms_version: 1, data_processing_version: 1 });
    const owner = await world.admin.query<{ id: string }>(
      'SELECT id FROM user_account WHERE email = $1',
      [form.email],
    );
    expect(accepted.rows[0]?.user_id).toBe(owner.rows[0]?.id);
    // The key of the organization was made on activation.
    expect(
      await count('SELECT count(*) AS n FROM tenant_key WHERE tenant_id = $1', [created?.id]),
    ).toBe(1);
    const trail = await audits(created?.id ?? '');
    expect(trail.map((row) => row.action)).toEqual([
      'signup.created',
      'terms.accepted',
      'signup.verified',
    ]);
    expect(trail[1]?.metadata).toEqual({ terms: 1, dataProcessing: 1 });
    expect(trail[1]?.actor_user_id).not.toBeNull();
    expect(trail[2]?.actor_user_id).not.toBeNull();
  });

  it('lets the person who owns the address set the password: a stranger who signed up with it chooses nothing (JD-S6 R1-S6-3)', async () => {
    // The stranger types the victim's address on the public form. The form has no password field.
    const victim = world.form({ password: 'la frase que eligio la victima 2031' });
    const attacker = await world.signUp({ email: victim.email, ownerName: 'Intruso' });
    await world.idle();
    expect(attacker.response.statusCode).toBe(200);

    // The link goes to the victim, who sets the password at the link.
    const link = world.linkTo(victim.email);
    const verified = await world.verify(link, { password: victim.password });
    expect(verified.statusCode, verified.body).toBe(200);

    const asVictim = await world.tenantPost(link.slug, '/auth/login', {
      email: victim.email,
      password: victim.password,
    });
    const asStranger = await world.tenantPost(link.slug, '/auth/login', {
      email: victim.email,
      password: PASSWORD,
    });
    expect(asVictim.statusCode, asVictim.body).toBe(200);
    expect(asStranger.statusCode).not.toBe(200);
  });

  it('records the acceptance when the owner gives it, with the instant of the verification and not of the form (JD-S6 R1-S6-3)', async () => {
    const { form } = await world.signUp();
    await world.idle();
    const link = world.linkTo(form.email);
    const created = await world.tenantOf(link.slug);
    expect(
      await count('SELECT count(*) AS n FROM terms_acceptance WHERE tenant_id = $1', [created?.id]),
    ).toBe(0);
    world.advance(3 * 3_600_000);

    const response = await world.verify(link);

    expect(response.statusCode, response.body).toBe(200);
    const accepted = await world.admin.query<{ accepted_at: Date }>(
      'SELECT accepted_at FROM terms_acceptance WHERE tenant_id = $1',
      [created?.id],
    );
    expect(accepted.rows).toHaveLength(1);
    expect(accepted.rows[0]?.accepted_at.getTime()).toBe(world.now().getTime());
  });

  it('refuses an owner who does not accept both documents, creates nothing and keeps the link', async () => {
    const { form } = await world.signUp();
    await world.idle();
    const link = world.linkTo(form.email);
    const created = await world.tenantOf(link.slug);

    for (const patch of [
      { acceptTerms: false },
      { acceptDataProcessing: false },
      { acceptTerms: false, acceptDataProcessing: false },
    ]) {
      const response = await world.verify(link, patch);

      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ code: 'signup_terms_required' });
    }
    expect((await world.tenantOf(link.slug))?.status).toBe('unverified');
    expect(
      await count('SELECT count(*) AS n FROM terms_acceptance WHERE tenant_id = $1', [created?.id]),
    ).toBe(0);
    // The link was not spent.
    expect((await world.verify(link)).statusCode).toBe(200);
  });

  it('applies the password rules of identity at the link: a weak password creates nothing and keeps the link', async () => {
    const { form } = await world.signUp({ email: 'carolina.gomez@example.test' });
    await world.idle();
    const link = world.linkTo(form.email);
    const created = await world.tenantOf(link.slug);

    const common = await world.verify(link, { password: 'password1234' });
    const short = await world.verify(link, { password: 'corta' });
    const ownEmail = await world.verify(link, { password: 'carolina.gomez 2031' });

    for (const response of [common, short, ownEmail]) {
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ code: 'validation_failed' });
    }
    const fields = (response: typeof common) =>
      (response.json<{ errors?: { path: string; i18nKey: string }[] }>().errors ?? []).map(
        (field) => `${field.path}:${field.i18nKey}`,
      );
    expect(fields(common)).toEqual(['password:auth.password.common']);
    expect(fields(short)).toEqual(['password:auth.password.too_short']);
    expect(fields(ownEmail)).toEqual(['password:auth.password.contains_email']);
    expect((await world.tenantOf(link.slug))?.status).toBe('unverified');
    expect(
      await count('SELECT count(*) AS n FROM user_account WHERE email = $1', [form.email]),
    ).toBe(0);
    expect(created?.status).toBe('unverified');
    expect((await world.verify(link)).statusCode).toBe(200);
  });

  it('lands the owner signed in: the session is the owner of the organization, with the second factor still to enroll', async () => {
    const { form } = await world.signUp();
    await world.idle();
    const link = world.linkTo(form.email);
    const verified = await world.verify(link);
    const cookie = String(verified.headers['set-cookie']).split(';')[0] ?? '';

    const me = await world.tenantGet(link.slug, '/auth/me', { cookie });

    expect(me.statusCode, me.body).toBe(200);
    const profile = me.json<{
      user: { email: string };
      roles: string[];
      scope: string;
      tenantStatus: string;
      needsWizard: boolean;
      twoFactor: { enrolled: boolean; required: boolean; graceEndsAt: string | null };
    }>();
    expect(profile).toMatchObject({
      user: { email: form.email },
      roles: ['owner'],
      scope: 'full',
      tenantStatus: 'active',
      needsWizard: true,
    });
    // The rules of identity: an owner must enroll a second factor, with seven days from now.
    expect(profile.twoFactor).toMatchObject({ enrolled: false, required: true });
    const graceMs = new Date(profile.twoFactor.graceEndsAt ?? 0).getTime() - world.now().getTime();
    expect(Math.round(graceMs / 86_400_000)).toBe(7);
  });

  it('keeps the record of the acceptance in what the organization takes with it when it leaves', async () => {
    const { form } = await world.signUp();
    await world.idle();
    const link = world.linkTo(form.email);
    await world.verify(link);
    const created = await world.tenantOf(link.slug);

    const exported = await createWithTenant(runtime.db)(
      { tenantId: created?.id ?? '', userId: SYSTEM_USER_ID },
      (tx) => exportOnboarding({ tx } as never),
    );

    expect(exported).toMatchObject({
      termsAcceptances: [{ termsVersion: 1, dataProcessingVersion: 1 }],
    });
    expect(JSON.stringify(exported)).not.toContain(form.email);
  });

  it('lets the owner sign in with the password chosen at the link', async () => {
    const { form } = await world.signUp();
    await world.idle();
    const link = world.linkTo(form.email);
    await world.verify(link);

    const login = await world.tenantPost(link.slug, '/auth/login', {
      email: form.email,
      password: form.password,
    });

    expect(login.statusCode, login.body).toBe(200);
    expect(login.json()).toEqual({ next: 'authenticated' });
  });

  it('works once: the link is spent, and a second visit gets the answer of a link that does not work', async () => {
    const { form } = await world.signUp();
    await world.idle();
    const link = world.linkTo(form.email);
    await world.verify(link);

    const again = await world.verify(link);

    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ code: 'signup_link_invalid' });
  });

  it('offers a new link when the old one expired, and the new one works', async () => {
    const { form } = await world.signUp();
    await world.idle();
    const old = world.linkTo(form.email);
    world.advance(25 * 3_600_000);

    const expired = await world.verify(old);
    const renewed = await world.renew(old.slug);
    await world.idle();
    const fresh = world.linkTo(form.email);
    const done = await world.verify({ ...old, token: fresh.token });

    expect(expired.statusCode).toBe(400);
    expect(expired.json()).toMatchObject({ code: 'signup_link_invalid' });
    expect(renewed.statusCode).toBe(200);
    expect(fresh.token).not.toBe(old.token);
    expect(done.statusCode, done.body).toBe(200);
  });

  it('answers the same for a token that never existed, one of another organization, and a malformed one', async () => {
    const { form: first } = await world.signUp();
    const { form: second } = await world.signUp();
    await world.idle();
    const mine = world.linkTo(first.email);
    const theirs = world.linkTo(second.email);

    const answers = [
      await world.verify({ ...mine, token: 'x'.repeat(43) }),
      await world.verify({ ...mine, token: theirs.token }),
      await world.verify({ ...mine, token: 'corto' }),
    ];

    for (const answer of answers) {
      expect(answer.statusCode).toBe(400);
      expect(answer.json()).toMatchObject({ code: 'signup_link_invalid' });
    }
    expect(
      new Set(answers.map((answer) => JSON.stringify({ ...answer.json(), requestId: 0 }))).size,
    ).toBe(1);
    // The link of the other organization still works on its own host.
    expect((await world.verify(theirs)).statusCode).toBe(200);
  });

  it('never confirms an address that got an account while the link was in the mailbox', async () => {
    const { form } = await world.signUp();
    await world.idle();
    const link = world.linkTo(form.email);
    // Somebody else's invitation to the same address was accepted in the meantime.
    const other = await world.signUp();
    await world.idle();
    const otherLink = world.linkTo(other.form.email);
    await world.verify(otherLink);
    await world.admin.query(`UPDATE user_account SET email = $1 WHERE email = $2`, [
      form.email,
      other.form.email,
    ]);

    const response = await world.verify(link);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'signup_link_invalid' });
    expect((await world.tenantOf(link.slug))?.status).toBe('unverified');
  });

  it('activates nothing when the trial cannot start, and works when it can', async () => {
    const { form } = await world.signUp();
    await world.idle();
    const link = world.linkTo(form.email);
    world.trial.refuse = true;

    const refused = await world.verify(link);
    world.trial.refuse = false;

    expect(refused.statusCode).toBe(500);
    expect((await world.tenantOf(link.slug))?.status).toBe('unverified');
    expect(
      await count('SELECT count(*) AS n FROM user_account WHERE email = $1', [form.email]),
    ).toBe(0);
    // The link was not spent: the same one works once the door is open.
    const retried = await world.verify(link);
    expect(retried.statusCode, retried.body).toBe(200);
  });

  it('is not served on the platform host, and an active organization answers like a bad link', async () => {
    const { form } = await world.signUp();
    await world.idle();
    const link = world.linkTo(form.email);
    await world.verify(link);

    const onPlatform = await world.platformPost('/public/signup/verify', { token: link.token });
    const onActive = await world.verify(link);

    expect(onPlatform.statusCode).toBe(404);
    expect(onActive.statusCode).toBe(400);
  });
});
