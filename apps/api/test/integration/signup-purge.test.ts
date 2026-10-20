import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { SYSTEM_USER_ID, createWithTenant } from '../../src/platform/db/tenant-context.js';
import { listTenantTables } from '../support/isolation.js';
import { createSignupWorld, type SignupWorld } from '../support/signup-world.js';

/**
 * The purge of the signups nobody confirmed (S6.02, task 6.12; retention exception 2 of the tenancy
 * rule). It removes an unverified organization older than seven days with what it holds, writes the
 * platform trail, and cannot touch a verified organization nor anything that holds data.
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

const DAY = 86_400_000;

/** A signup that waits for its link, `ageDays` old. */
async function waiting(ageDays: number) {
  const { form } = await world.signUp();
  await world.idle();
  const link = world.linkTo(form.email);
  const created = await world.tenantOf(link.slug);
  await world.admin.query(
    `UPDATE tenant SET created_at = now() - make_interval(secs => $2) WHERE id = $1`,
    [created?.id, ageDays * 86_400],
  );
  return { form, link, id: created?.id ?? '' };
}

const exists = async (id: string) =>
  Number(
    (await world.admin.query<{ n: string }>('SELECT count(*) AS n FROM tenant WHERE id = $1', [id]))
      .rows[0]?.n,
  ) === 1;

const rowsFor = async (table: string, id: string) =>
  Number(
    (
      await world.admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1`,
        [id],
      )
    ).rows[0]?.n,
  );

describe('the purge of the signups nobody confirmed', () => {
  it('removes an unverified organization older than seven days with its pending signup, links and trail', async () => {
    const old = await waiting(8);
    expect(await rowsFor('audit_event', old.id)).toBeGreaterThan(0);
    expect(await rowsFor('action_token', old.id)).toBeGreaterThan(0);

    const purged = await world.worker.purgeUnverified();

    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await exists(old.id)).toBe(false);
    for (const table of ['signup_pending', 'action_token', 'audit_event', 'job_execution']) {
      expect(await rowsFor(table, old.id), table).toBe(0);
    }
    // The link of the removed organization does not work any more.
    const response = await world.tenantPost(old.link.slug, '/public/signup/verify', {
      token: old.link.token,
    });
    expect(response.statusCode).toBe(404);
  });

  it('writes the purge in the platform trail, with the age and nothing that identifies the person', async () => {
    const old = await waiting(9);

    await world.worker.purgeUnverified();

    const events = await world.admin.query<{
      action: string;
      outcome: string;
      operator_id: string | null;
      resource_type: string;
      resource_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, outcome, operator_id, resource_type, resource_id, metadata
         FROM platform_audit_event WHERE target_tenant_id = $1`,
      [old.id],
    );
    expect(events.rows).toEqual([
      {
        action: 'signup.purged',
        outcome: 'allow',
        operator_id: null,
        resource_type: 'tenant',
        resource_id: old.id,
        metadata: { ageDays: 9 },
      },
    ]);
    const text = JSON.stringify(events.rows);
    expect(text).not.toContain(old.form.email);
    expect(text).not.toContain(old.link.slug);
    expect(text).not.toContain(old.form.ownerName);
  });

  it('leaves alone an organization younger than seven days', async () => {
    const recent = await waiting(6);
    const fresh = await waiting(0);

    await world.worker.purgeUnverified();

    expect(await exists(recent.id)).toBe(true);
    expect(await exists(fresh.id)).toBe(true);
    expect(await rowsFor('signup_pending', recent.id)).toBe(1);
  });

  it('never touches a verified organization, however old', async () => {
    const old = await waiting(10);
    const verified = await world.tenantPost(old.link.slug, '/public/signup/verify', {
      token: old.link.token,
    });
    expect(verified.statusCode, verified.body).toBe(200);
    // The age is set after the verification, so the organization is as old as an abandoned one.
    await world.admin.query(
      `UPDATE tenant SET created_at = now() - interval '30 days' WHERE id = $1`,
      [old.id],
    );

    await world.worker.purgeUnverified();

    expect(await exists(old.id)).toBe(true);
    expect(await rowsFor('membership', old.id)).toBe(1);
    expect(await rowsFor('signup_pending', old.id)).toBe(1);
    expect(await rowsFor('terms_acceptance', old.id)).toBe(1);
    expect(await rowsFor('audit_event', old.id)).toBeGreaterThan(0);
  });

  it('leaves an unverified organization that somebody put data in, which a bare signup never has', async () => {
    const old = await waiting(12);
    const withData = await waiting(12);
    // Anything that points at the organization stops its removal: here a location, as a patient would.
    await world.admin.query(
      `INSERT INTO location (tenant_id, name, time_zone) VALUES ($1, 'Sede', 'America/Argentina/Buenos_Aires')`,
      [withData.id],
    );

    await world.worker.purgeUnverified();

    expect(await exists(old.id)).toBe(false);
    expect(await exists(withData.id)).toBe(true);
    expect(await rowsFor('location', withData.id)).toBe(1);
    expect(await rowsFor('signup_pending', withData.id)).toBe(1);
    // A failed attempt leaves no trace in the platform trail: it removed nothing.
    const events = await world.admin.query(
      'SELECT 1 FROM platform_audit_event WHERE target_tenant_id = $1',
      [withData.id],
    );
    expect(events.rowCount).toBe(0);
  });

  it('never purges what is younger than a day, whatever cutoff it is given', async () => {
    const fresh = await waiting(0);
    await world.admin.query(
      `UPDATE tenant SET created_at = now() - interval '2 hours' WHERE id = $1`,
      [fresh.id],
    );

    // The cutoff is ten days in the future: every organization is "older" than it, but the function
    // never goes past a day ago, whoever calls it.
    await runtime.db.transaction((tx) =>
      tx.execute(sql`select app.signup_purge(now() + interval '10 days', 500) as purged`),
    );

    expect(await exists(fresh.id)).toBe(true);
    expect(await rowsFor('signup_pending', fresh.id)).toBe(1);
  });

  it('works from the cutoff of the clock it is given: a clock that moved on purges what the old one would not', async () => {
    const aged = await waiting(0);
    await world.admin.query(
      `UPDATE tenant SET created_at = now() - interval '2 days' WHERE id = $1`,
      [aged.id],
    );

    // On the real clock a two day old signup is far from seven days.
    expect(await world.worker.purgeUnverified()).toBe(0);
    expect(await exists(aged.id)).toBe(true);
    // Six days later it is eight days old: the cutoff is a day ago, and the floor of a day is met.
    world.advance(6 * DAY);
    const purged = await world.worker.purgeUnverified();
    world.advance(-6 * DAY);

    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await exists(aged.id)).toBe(false);
  });

  it('is the only way the runtime role removes an organization: a plain delete is refused', async () => {
    const old = await waiting(8);

    const attempt = createWithTenant(runtime.db)(
      { tenantId: old.id, userId: SYSTEM_USER_ID },
      (tx) => tx.execute(sql`DELETE FROM tenant WHERE id = ${old.id}`),
    );

    await expect(attempt).rejects.toThrow();
    expect(await exists(old.id)).toBe(true);
  });
});

describe('what a bare signup holds', () => {
  it('has rows in the four tables the purge deletes from and in no other one: no patient, no record, no member', async () => {
    const { id } = await waiting(0);
    const tables = await listTenantTables(world.admin);

    const holding: string[] = [];
    for (const table of tables) {
      if ((await rowsFor(table, id)) > 0) holding.push(table);
    }

    expect(holding.sort()).toEqual(['action_token', 'audit_event', 'signup_pending']);
  });

  it('is deleted by a function that names exactly those tables and the organization, and nothing else', () => {
    const migration = readFileSync(
      fileURLToPath(new URL('../../src/db/migrations/0640_signup.sql', import.meta.url)),
      'utf8',
    );
    const purge = migration.slice(migration.indexOf('CREATE FUNCTION app.signup_purge'));
    const deletes = [...purge.matchAll(/DELETE FROM public\.(\w+)/g)].map((match) => match[1]);

    expect(deletes).toEqual([
      'signup_pending',
      'action_token',
      'job_execution',
      'audit_event',
      'tenant',
    ]);
  });
});
