import type { PortalAppointmentsResponse, PortalMeResponse, Problem } from '@consultorio/contracts';
import { READ_ONLY_ALLOWLIST } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { hostOf } from '../support/app.js';
import {
  createFakePortalConsents,
  createFakePortalPrescriptions,
} from '../support/portal-fakes.js';
import { createPortalWorld, type PortalWorld } from '../support/portal-world.js';

/**
 * One person, two organizations, and a read-only one (S5.09, task 5.37): the portal is the host's
 * organization and nothing else, and in a read-only organization the patient keeps reading, signing
 * in and the writes that protect them, while everything else answers 402.
 */
let runtime: DbHandle;
let north: PortalWorld;
let south: PortalWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  north = await createPortalWorld(runtime, {
    slug: 'portal-north',
    ports: { consent: createFakePortalConsents(), prescriptions: createFakePortalPrescriptions() },
  });
  south = await createPortalWorld(runtime, { slug: 'portal-south' });
});

afterAll(async () => {
  await north.close();
  await south.close();
  await runtime.close();
});

describe('one person in two organizations', () => {
  it('has two identities and sees only the organization of the host they signed in to', async () => {
    const email = `persona-${crypto.randomUUID().slice(0, 6)}@example.test`;
    const northPatient = await north.patientWith({ email, givenNames: 'Norte' });
    const southPatient = await south.patientWith({ email, givenNames: 'Sur' });
    const northIdentity = await north.onboard(northPatient);
    const southIdentity = await south.onboard(southPatient);
    const northVisitor = await north.signInAs(email);
    const southVisitor = await south.signInAs(email);
    await north.book(41, '09:00', { patientId: northPatient });
    await south.book(41, '09:00', { patientId: southPatient });

    const northMe = (await northVisitor.get('/portal/me')).json<PortalMeResponse>();
    const southMe = (await southVisitor.get('/portal/me')).json<PortalMeResponse>();
    const northAppointments = (
      await northVisitor.get('/portal/appointments')
    ).json<PortalAppointmentsResponse>();
    const southAppointments = (
      await southVisitor.get('/portal/appointments')
    ).json<PortalAppointmentsResponse>();

    expect(northIdentity.id).not.toBe(southIdentity.id);
    expect(northMe.links.map((link) => link.patientId)).toEqual([northPatient]);
    expect(southMe.links.map((link) => link.patientId)).toEqual([southPatient]);
    expect(northAppointments.upcoming).toHaveLength(1);
    expect(southAppointments.upcoming).toHaveLength(1);
    expect(northAppointments.upcoming[0]?.id).not.toBe(southAppointments.upcoming[0]?.id);
  });

  it('cannot carry the session of one organization to the other, in either direction', async () => {
    const email = `ida-${crypto.randomUUID().slice(0, 6)}@example.test`;
    await north.onboard(await north.patientWith({ email }));
    await south.onboard(await south.patientWith({ email }));
    const northVisitor = await north.signInAs(email);
    const southVisitor = await south.signInAs(email);
    const onOther = (world: PortalWorld, cookie: string) =>
      world.app.inject({
        method: 'GET',
        url: '/portal/me',
        headers: { host: hostOf(world.slug), cookie },
      });

    expect((await onOther(south, northVisitor.cookie())).statusCode).toBe(401);
    expect((await onOther(north, southVisitor.cookie())).statusCode).toBe(401);
    expect((await onOther(north, northVisitor.cookie())).statusCode).toBe(200);
  });

  it('asks for a code only for the organization of the host: the slug of the path is never read', async () => {
    const email = `codigo-${crypto.randomUUID().slice(0, 6)}@example.test`;
    await south.onboard(await south.patientWith({ email }));
    north.email.clear();
    south.email.clear();
    const visitor = north.visitor();

    // The host is north, the path names south: it is north's portal that answers, and north has
    // no such account.
    const crossed = await visitor.post(`/public/${south.slug}/portal/otp`, {
      email,
      challengeProof: await visitor.solve(),
    });
    // north has no such account: the same answer as for any address, and nothing is sent.
    const own = await visitor.post(`/public/${north.slug}/portal/otp`, {
      email,
      challengeProof: await visitor.solve(),
    });
    await north.runJobs();
    await south.runJobs();

    expect(crossed.statusCode).toBe(200);
    expect(own.statusCode).toBe(200);
    expect(north.email.sent).toEqual([]);
    expect(south.email.sent).toEqual([]);
  });

  it('never takes the organization from a parameter or a header of the request', async () => {
    const { visitor } = await north.patientSession();

    const withQuery = await visitor.get(`/portal/me?tenantId=${south.tenant.id}`);
    const withHeader = await north.app.inject({
      method: 'GET',
      url: '/portal/me',
      headers: {
        host: hostOf(north.slug),
        cookie: visitor.cookie(),
        'x-tenant-id': south.tenant.id,
        'x-forwarded-host': hostOf(south.slug),
      },
    });

    expect(withQuery.statusCode).toBe(400);
    expect(withHeader.statusCode).toBe(200);
    expect(withHeader.json<PortalMeResponse>().organizationName).toBeTruthy();
    const stillNorth = withHeader.json<PortalMeResponse>();
    const northMe = (await visitor.get('/portal/me')).json<PortalMeResponse>();
    expect(stillNorth.links.map((link) => link.id)).toEqual(northMe.links.map((link) => link.id));
  });
});

describe('a read-only organization', () => {
  const setStatus = (status: 'active' | 'read_only') =>
    north.inTenant((tx) =>
      tx.execute(
        status === 'read_only'
          ? sql`UPDATE tenant SET status = 'read_only', read_only_since = now() WHERE id = ${north.tenant.id}`
          : sql`UPDATE tenant SET status = 'active', read_only_since = NULL WHERE id = ${north.tenant.id}`,
      ),
    );

  const portalRoutes = () =>
    [...north.app.routeAuth]
      .filter(([route, auth]) => auth === 'portal' && !route.startsWith('HEAD '))
      .map(([route]) => route)
      .sort();

  const concrete = (url: string) =>
    url.replaceAll(/:[A-Za-z]+/g, (name) =>
      name === ':token' ? 'a'.repeat(43) : '0190a000-0000-7000-8000-00000000dead',
    );

  it('keeps open only reading, authentication and the writes that protect the patient', () => {
    const open = portalRoutes()
      .filter((route) => !route.startsWith('GET '))
      .filter((route) => {
        const category = north.app.routeCategories.get(route);
        return category !== undefined && READ_ONLY_ALLOWLIST.includes(category);
      });

    expect(open).toEqual(
      [
        'DELETE /portal/sessions/:id',
        'POST /portal/consents/:id/revoke',
        'POST /portal/appointments/:id/cancel',
        'POST /portal/copy-requests',
        'POST /portal/documents/:id/download-link',
        'POST /portal/invoices/:id/download-link',
        'POST /portal/consents/:id/download-link',
        'POST /portal/logout',
        'POST /portal/prescriptions/:id/download-link',
        'POST /portal/rectification-requests',
        'POST /portal/subject',
      ].sort(),
    );
  });

  it('answers every portal route by its category: 402 for what is not allowed, anything else for the rest', async () => {
    const { visitor } = await north.patientSession();
    await setStatus('read_only');
    try {
      const routes = portalRoutes();
      expect(routes.length).toBeGreaterThanOrEqual(20);
      for (const route of routes) {
        const method = route.slice(0, route.indexOf(' '));
        const url = concrete(route.slice(route.indexOf(' ') + 1));
        const category = north.app.routeCategories.get(route);
        const response =
          method === 'GET'
            ? await visitor.get(url)
            : method === 'DELETE'
              ? await visitor.delete(url)
              : method === 'PATCH'
                ? await visitor.patch(url, {})
                : await visitor.post(url, {});
        const allowed = category !== undefined && READ_ONLY_ALLOWLIST.includes(category);

        if (allowed) {
          expect(response.statusCode, route).not.toBe(402);
        } else {
          expect(response.statusCode, route).toBe(402);
          expect(response.json<Problem>().code, route).toBe('tenant_read_only');
        }
      }
    } finally {
      await setStatus('active');
    }
  }, 120_000);

  it('lets the patient sign in: the code is sent and the session starts', async () => {
    const { email } = await north.patientSession();
    await setStatus('read_only');
    try {
      north.email.clear();

      const visitor = await north.signInAs(email);

      expect((await visitor.get('/portal/me')).statusCode).toBe(200);
      expect(north.email.lastTo(email)?.subject).toContain('Ingrese');
    } finally {
      await setStatus('active');
    }
  });

  it('lets the patient cancel an appointment, and read what they have', async () => {
    await north.api.patch('/settings', north.owner, {
      onlineBooking: { rescheduleDeadlineHours: 2 },
    });
    const { visitor, patientId } = await north.patientSession();
    const booked = await north.book(42, '10:00', { patientId });
    await setStatus('read_only');
    try {
      const cancel = await visitor.post(`/portal/appointments/${booked.id}/cancel`, {});
      const list = await visitor.get('/portal/appointments');
      const confirm = await visitor.post(`/portal/appointments/${booked.id}/confirm`, {});

      expect(cancel.statusCode, cancel.body).toBe(200);
      expect(list.statusCode).toBe(200);
      expect(confirm.statusCode).toBe(402);
    } finally {
      await setStatus('active');
      await north.api.patch('/settings', north.owner, {
        onlineBooking: { rescheduleDeadlineHours: 12 },
      });
    }
  });
});
