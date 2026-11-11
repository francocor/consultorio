import type { AuditAction, LocationDto } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { membershipLocation } from '../../src/db/schema/access.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { location } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let app: FastifyInstance;
let api: ReturnType<typeof clientFor>;
let tenant: TestTenant;
let other: TestTenant;
let owner: TestSession;
let admin: TestSession;
let reception: TestSession;
let professional: TestSession;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  tenant = await createTestTenant(runtime, { slug: 'locations-a' });
  other = await createTestTenant(runtime, { slug: 'locations-b' });
  app = buildTestApplication(runtime);
  api = clientFor(app, 'locations-a');
  const make = (roles: ('owner' | 'admin' | 'reception' | 'professional')[]) =>
    createTestUser(runtime, tenant.id, { roles, password: TEST_PASSWORD });
  owner = await signInAs(app, 'locations-a', await make(['owner']));
  admin = await signInAs(app, 'locations-a', await make(['admin']));
  reception = await signInAs(app, 'locations-a', await make(['reception']));
  professional = await signInAs(app, 'locations-a', await make(['professional']));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

async function create(name: string, timeZone?: string, by: TestSession = owner) {
  const response = await api.post('/locations', by, timeZone ? { name, timeZone } : { name });
  expect(response.statusCode).toBe(201);
  return response.json<LocationDto>();
}

async function rows(action: AuditAction, tenantId = tenant.id) {
  return asTenant(runtime, tenantId, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenantId), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

async function foreignLocation(name: string): Promise<string> {
  const [row] = await asTenant(runtime, other.id, (tx) =>
    tx
      .insert(location)
      .values({ tenantId: other.id, name, timeZone: 'UTC' })
      .returning({ id: location.id }),
  );
  return row?.id ?? '';
}

const names = (response: LightMyRequestResponse) =>
  response.json<{ locations: LocationDto[] }>().locations.map((location) => location.name);

describe('creating and editing locations', () => {
  it('gives a new location the country default time zone when none is sent', async () => {
    const created = await create('Centro');

    expect(created).toMatchObject({
      name: 'Centro',
      timeZone: 'America/Argentina/Buenos_Aires',
      active: true,
    });
  });

  it('keeps the time zone the owner chose, and audits the creation', async () => {
    const created = await create('Montevideo', 'America/Montevideo', admin);

    expect(created.timeZone).toBe('America/Montevideo');
    const [row] = await rows('location.created');
    expect(row).toMatchObject({
      outcome: 'allow',
      resourceType: 'location',
      resourceId: created.id,
    });
  });

  it('edits the name and the zone and audits which fields changed, not the values', async () => {
    const created = await create('Provisoria');

    const response = await api.patch(`/locations/${created.id}`, owner, {
      name: 'Norte',
      timeZone: 'America/Cordoba',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: 'Norte', timeZone: 'America/Cordoba' });
    const [row] = await rows('location.updated');
    expect(row).toMatchObject({
      resourceId: created.id,
      metadata: { fields: ['name', 'timeZone'] },
    });
    expect(JSON.stringify(row?.metadata)).not.toContain('Norte');
  });

  it('refuses reception and professionals, an unknown zone and an empty edit', async () => {
    const created = await create('Protegida');

    expect((await api.post('/locations', reception, { name: 'X' })).statusCode).toBe(403);
    expect((await api.post('/locations', professional, { name: 'X' })).statusCode).toBe(403);
    expect((await api.patch(`/locations/${created.id}`, reception, { name: 'X' })).statusCode).toBe(
      403,
    );
    expect(
      (await api.post('/locations', owner, { name: 'Marte', timeZone: 'Mars/Base' })).statusCode,
    ).toBe(400);
    expect((await api.patch(`/locations/${created.id}`, owner, {})).statusCode).toBe(400);
  });

  it("answers 404 for another organization's location", async () => {
    const id = await foreignLocation('Ajena');

    expect((await api.patch(`/locations/${id}`, owner, { name: 'Mía' })).statusCode).toBe(404);
    expect((await api.post(`/locations/${id}/deactivate`, owner)).statusCode).toBe(404);
  });
});

describe('deactivating a location', () => {
  it('hides it from new selections, keeps it for history, and audits both directions', async () => {
    const created = await create('Temporal');

    const off = await api.post(`/locations/${created.id}/deactivate`, owner);

    expect(off.statusCode).toBe(200);
    expect(off.json<LocationDto>().active).toBe(false);
    expect(names(await api.get('/locations', owner))).not.toContain('Temporal');
    expect(names(await api.get('/locations?includeInactive=true', owner))).toContain('Temporal');
    expect((await rows('location.deactivated'))[0]).toMatchObject({ resourceId: created.id });

    const on = await api.post(`/locations/${created.id}/reactivate`, owner);
    expect(on.json<LocationDto>().active).toBe(true);
    expect(names(await api.get('/locations', owner))).toContain('Temporal');
    expect((await rows('location.reactivated'))[0]).toMatchObject({ resourceId: created.id });
  });

  it('is idempotent and writes no second audit row', async () => {
    const created = await create('Dos veces');
    await api.post(`/locations/${created.id}/deactivate`, owner);
    const before = (await rows('location.deactivated')).length;

    const again = await api.post(`/locations/${created.id}/deactivate`, owner);

    expect(again.statusCode).toBe(200);
    expect((await rows('location.deactivated')).length).toBe(before);
  });

  it('keeps the member assignments of an inactive location (the history stays intact)', async () => {
    const created = await create('Con historia');
    await api.put(`/members/${reception.user.membershipId}/locations`, owner, {
      locationIds: [created.id],
    });

    await api.post(`/locations/${created.id}/deactivate`, owner);

    const live = await asTenant(runtime, tenant.id, (tx) =>
      tx.select().from(membershipLocation).where(eq(membershipLocation.locationId, created.id)),
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.removedAt).toBeNull();
  });
});

describe('who sees which locations', () => {
  it('shows owners and admins every location and reception only the ones it is assigned to', async () => {
    const centro = await create('Vista Centro');
    const norte = await create('Vista Norte');
    await api.put(`/members/${reception.user.membershipId}/locations`, owner, {
      locationIds: [centro.id],
    });

    expect(names(await api.get('/locations', owner))).toEqual(
      expect.arrayContaining(['Vista Centro', 'Vista Norte']),
    );
    expect(names(await api.get('/locations', admin))).toEqual(
      expect.arrayContaining(['Vista Centro', 'Vista Norte']),
    );
    const own = names(await api.get('/locations', reception));
    expect(own).toContain('Vista Centro');
    expect(own).not.toContain('Vista Norte');
    expect(norte.id).not.toBe(centro.id);
  });

  it('shows a professional the locations they practice at', async () => {
    const consultorio = await create('Consultorio propio');
    await create('Otro consultorio');
    await api.put(`/members/${professional.user.membershipId}/locations`, owner, {
      locationIds: [consultorio.id],
    });

    const own = names(await api.get('/locations', professional));

    expect(own).toEqual(['Consultorio propio']);
  });

  it('shows a member with no assignment nothing', async () => {
    const lonely = await signInAs(
      app,
      'locations-a',
      await createTestUser(runtime, tenant.id, { roles: ['reception'], password: TEST_PASSWORD }),
    );

    expect(names(await api.get('/locations', lonely))).toEqual([]);
  });
});

describe('assigning a member to locations', () => {
  it('replaces the set, ends removed assignments without deleting them, and audits added and removed', async () => {
    const one = await create('Asignable 1');
    const two = await create('Asignable 2');
    const member = reception.user.membershipId;
    await api.put(`/members/${member}/locations`, owner, { locationIds: [one.id] });

    const response = await api.put(`/members/${member}/locations`, owner, {
      locationIds: [two.id],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ membershipId: member, locationIds: [two.id] });
    const all = await asTenant(runtime, tenant.id, (tx) =>
      tx.select().from(membershipLocation).where(eq(membershipLocation.membershipId, member)),
    );
    expect(all.find((row) => row.locationId === one.id)?.removedAt).toBeInstanceOf(Date);
    const [row] = await rows('location_membership.changed');
    expect(row).toMatchObject({
      resourceId: member,
      metadata: { added: [two.id], removed: [one.id] },
    });
    expect((await api.get(`/members/${member}/locations`, owner)).json()).toEqual({
      membershipId: member,
      locationIds: [two.id],
    });
  });

  it('can assign again a location that was removed', async () => {
    const place = await create('Vuelta');
    const member = professional.user.membershipId;
    await api.put(`/members/${member}/locations`, owner, { locationIds: [place.id] });
    await api.put(`/members/${member}/locations`, owner, { locationIds: [] });

    const again = await api.put(`/members/${member}/locations`, owner, { locationIds: [place.id] });

    expect(again.statusCode).toBe(200);
    expect(again.json<{ locationIds: string[] }>().locationIds).toEqual([place.id]);
  });

  it('rejects a location of another organization as not found and an inactive one as a conflict', async () => {
    const foreignId = await foreignLocation('Ajena 2');
    const closed = await create('Cerrada');
    await api.post(`/locations/${closed.id}/deactivate`, owner);
    const member = reception.user.membershipId;

    const outside = await api.put(`/members/${member}/locations`, owner, {
      locationIds: [foreignId],
    });
    const inactive = await api.put(`/members/${member}/locations`, owner, {
      locationIds: [closed.id],
    });

    expect(outside.statusCode).toBe(404);
    expect(inactive.statusCode).toBe(409);
  });

  it('is for those who manage staff, and 404 for a member of another organization', async () => {
    const stranger = await createTestUser(runtime, other.id, { roles: ['reception'] });

    expect(
      (
        await api.put(`/members/${professional.user.membershipId}/locations`, reception, {
          locationIds: [],
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await api.put(`/members/${stranger.membershipId}/locations`, owner, { locationIds: [] }))
        .statusCode,
    ).toBe(404);
  });
});
