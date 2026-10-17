import type { BookingLinkDto, BookingLinksResponse, Problem } from '@consultorio/contracts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBookingWorld, type BookingWorld } from '../support/booking-world.js';

let runtime: DbHandle;
let world: BookingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBookingWorld(runtime, { slug: 'booking-links' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const auditActions = async () =>
  (await world.inTenant((tx) => tx.select({ action: auditEvent.action }).from(auditEvent))).map(
    (row) => row.action,
  );

/** A professional with a link of their own, so a test can regenerate it without hurting the others. */
async function freshLinks() {
  const doctor = await world.addProfessional();
  return world.openLinks({ doctor });
}

describe('who manages the links', () => {
  it('lets the owner and an admin, and nobody else', async () => {
    for (const [member, status] of [
      [world.owner, 200],
      [world.admin, 200],
      [world.reception, 403],
      [world.doctor, 403],
    ] as const) {
      const response = await world.api.get('/booking-links', member);
      expect(response.statusCode, member.user.email).toBe(status);
    }
  });

  it('needs a session: an anonymous caller gets 401', async () => {
    expect((await world.api.get('/booking-links', null)).statusCode).toBe(401);
  });
});

describe('creating a link', () => {
  it('makes the organization link, disabled until somebody enables it, with an unguessable slug', async () => {
    const created = await world.api.post('/booking-links', world.owner, {});

    expect(created.statusCode, created.body).toBe(201);
    const link = created.json<BookingLinkDto>();
    expect(link).toMatchObject({
      professionalId: null,
      enabled: false,
      locationIds: [],
      typeIds: [],
      regeneratedAt: null,
      path: `/book/${link.slug}`,
    });
    expect(link.slug).toMatch(/^[a-z0-9]{12}$/);
  });

  it('refuses a second organization link', async () => {
    const again = await world.api.post('/booking-links', world.owner, {});

    expect(again.statusCode).toBe(409);
  });

  it('makes the link of a professional under the organization link and chooses what it exposes', async () => {
    const created = await world.api.post('/booking-links', world.owner, {
      professionalId: world.doctor.professionalId,
      enabled: true,
      typeIds: [world.consulta],
      locationIds: [world.centro],
    });

    expect(created.statusCode, created.body).toBe(201);
    const link = created.json<BookingLinkDto>();
    const organization = (await world.api.get('/booking-links', world.owner))
      .json<BookingLinksResponse>()
      .links.find((candidate) => candidate.professionalId === null);
    expect(link).toMatchObject({
      professionalId: world.doctor.professionalId,
      enabled: true,
      typeIds: [world.consulta],
      locationIds: [world.centro],
      path: `/book/${organization?.slug ?? ''}/p/${link.slug}`,
    });
  });

  it('refuses a second link for the same professional', async () => {
    const again = await world.api.post('/booking-links', world.owner, {
      professionalId: world.doctor.professionalId,
    });

    expect(again.statusCode).toBe(409);
  });

  it('creates the organization link by itself when a professional link comes first', async () => {
    const fresh = await createBookingWorld(runtime, { slug: 'booking-links-first' });
    try {
      const created = await fresh.api.post('/booking-links', fresh.owner, {
        professionalId: fresh.doctor.professionalId,
      });
      const listed = (
        await fresh.api.get('/booking-links', fresh.owner)
      ).json<BookingLinksResponse>();

      expect(created.statusCode, created.body).toBe(201);
      expect(listed.links).toHaveLength(2);
      expect(listed.links.find((link) => link.professionalId === null)?.enabled).toBe(false);
    } finally {
      await fresh.close();
    }
  });

  it('refuses a professional, type or location that is not of the organization', async () => {
    const other = '0190a000-0000-7000-8000-00000000dead';
    const missingProfessional = await world.api.post('/booking-links', world.owner, {
      professionalId: other,
    });
    const missingType = await world.api.post('/booking-links', world.owner, {
      professionalId: world.colleague.professionalId,
      typeIds: [other],
    });
    const missingLocation = await world.api.post('/booking-links', world.owner, {
      professionalId: world.colleague.professionalId,
      locationIds: [other],
    });

    expect(missingProfessional.statusCode).toBe(404);
    expect(missingType.statusCode).toBe(400);
    expect(missingLocation.statusCode).toBe(400);
  });

  it('takes neither the slug nor the tenant from the caller', async () => {
    const forged = await world.api.post('/booking-links', world.owner, {
      professionalId: world.colleague.professionalId,
      slug: 'chosen-by-me',
      tenantId: world.tenant.id,
    });

    expect(forged.statusCode).toBe(400);
  });

  it('refuses types and locations on the organization link, which carries none of its own', async () => {
    const fresh = await createBookingWorld(runtime, { slug: 'booking-links-org' });
    try {
      const response = await fresh.api.post('/booking-links', fresh.owner, {
        typeIds: [fresh.consulta],
      });

      expect(response.statusCode).toBe(400);
    } finally {
      await fresh.close();
    }
  });
});

describe('changing a link', () => {
  async function linkOf(professionalId: string): Promise<BookingLinkDto> {
    const listed = (
      await world.api.get('/booking-links', world.owner)
    ).json<BookingLinksResponse>();
    const found = listed.links.find((link) => link.professionalId === professionalId);
    if (!found) throw new Error('no such link');
    return found;
  }

  it('enables and disables, and audits each change under its own action', async () => {
    const link = await linkOf(world.doctor.professionalId);

    const off = await world.api.patch(`/booking-links/${link.id}`, world.admin, { enabled: false });
    const on = await world.api.patch(`/booking-links/${link.id}`, world.admin, { enabled: true });

    expect(off.json<BookingLinkDto>().enabled).toBe(false);
    expect(on.json<BookingLinkDto>().enabled).toBe(true);
    expect(await auditActions()).toEqual(
      expect.arrayContaining(['booking.link.enabled', 'booking.link.disabled']),
    );
  });

  it('does not audit an enable that changes nothing', async () => {
    const link = await linkOf(world.doctor.professionalId);
    const before = (await auditActions()).filter((action) => action === 'booking.link.enabled');

    await world.api.patch(`/booking-links/${link.id}`, world.owner, { enabled: true });

    const after = (await auditActions()).filter((action) => action === 'booking.link.enabled');
    expect(after).toHaveLength(before.length);
  });

  it('chooses the types and locations, replacing the previous choice', async () => {
    const link = await linkOf(world.doctor.professionalId);

    const changed = await world.api.patch(`/booking-links/${link.id}`, world.owner, {
      typeIds: [world.consulta, world.withBuffer],
      locationIds: [],
    });

    expect(changed.json<BookingLinkDto>()).toMatchObject({
      typeIds: [world.consulta, world.withBuffer],
      locationIds: [],
    });
  });

  it('refuses the slug, the professional and an empty change', async () => {
    const link = await linkOf(world.doctor.professionalId);

    for (const body of [{ slug: 'abcdefgh12' }, { professionalId: null }, {}]) {
      const response = await world.api.patch(`/booking-links/${link.id}`, world.owner, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('answers a link of nobody as not found', async () => {
    const missing = await world.api.patch(
      '/booking-links/0190a000-0000-7000-8000-00000000dead',
      world.owner,
      { enabled: true },
    );

    expect(missing.statusCode).toBe(404);
    expect(missing.json<Problem>().code).toBe('not_found');
  });
});

describe('regenerating a link', () => {
  it('gives the link a new slug at once, audits it and keeps what it exposes', async () => {
    const links = await freshLinks();

    const regenerated = await world.api.post(
      `/booking-links/${links.professional.id}/regenerate`,
      world.owner,
      {},
    );

    expect(regenerated.statusCode, regenerated.body).toBe(200);
    const next = regenerated.json<BookingLinkDto>();
    expect(next.slug).not.toBe(links.professional.slug);
    expect(next.slug).toMatch(/^[a-z0-9]{12}$/);
    expect(next.regeneratedAt).not.toBeNull();
    expect(next).toMatchObject({ typeIds: links.professional.typeIds, enabled: true });
    expect(await auditActions()).toContain('booking.link.regenerated');
  });

  it('kills the old address at once: it looks exactly like an address that never existed', async () => {
    const links = await freshLinks();
    const visitor = world.visitor();
    const oldPath = world.pagePath(links);
    expect((await visitor.get(oldPath)).statusCode).toBe(200);

    await world.api.post(`/booking-links/${links.professional.id}/regenerate`, world.owner, {});

    const dead = await visitor.get(oldPath);
    const never = await visitor.get(`/public/${links.organization.slug}/p/zzzzzzzzzzzz`);
    expect(dead.statusCode).toBe(404);
    expect({ ...dead.json<Problem>(), requestId: undefined }).toEqual({
      ...never.json<Problem>(),
      requestId: undefined,
    });
  });
});
