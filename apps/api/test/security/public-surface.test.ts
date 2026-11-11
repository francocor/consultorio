import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFakeScanner } from '../../src/adapters/fake-scanner/index.js';
import { createMemoryObjectStorage } from '../../src/adapters/memory-storage/index.js';
import { bookingLink } from '../../src/db/schema/online-booking.js';
import { patient } from '../../src/db/schema/patients.js';
import { appointment } from '../../src/db/schema/scheduling.js';
import { videoSession } from '../../src/db/schema/teleconsultation.js';
import { seedDemoTenant, type DemoSeedDeps } from '../../src/db/seed/demo/seed.js';
import { seedPlatformCatalogs } from '../../src/db/seed/platform.js';
import { createPasswordHasher } from '../../src/modules/identity/infrastructure/argon2.js';
import { createOwnerDb, createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { createActionTokens } from '../../src/platform/tokens/index.js';
import { BASE_DOMAIN, hostOf } from '../support/app.js';
import { createBookingWorld, type BookingWorld } from '../support/booking-world.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

/**
 * The public surface as a whole (design 4.5; online-booking, "Abuse protection"). Every address a
 * visitor can reach without signing in is probed for what a browser and a proxy rely on: the
 * hardening headers, a policy that lets nothing run, a referrer policy that keeps the link at home,
 * the same-origin rule for anything that changes state, and the absence of personal or clinical
 * data. The data is the Stage 3 demo organization: patients with clinical notes, bookings, a
 * waitlist and virtual appointments, so the probes meet real content.
 */

const PLAIN = 'sec-surface';
const DEMO = 'sec-surface-demo';
const NOW = new Date('2031-05-05T12:00:00.000Z');

let runtime: DbHandle;
let world: BookingWorld;
let demoId: string;
let orgSlug: string;
let proSlug: string;
let typeId: string;
/** Everything that identifies a patient of the demonstration organization. */
let personal: string[];
/** Words from the clinical notes the seed wrote. */
const CLINICAL = [
  'Hipertensión',
  'hipertensión',
  'Cuadro viral',
  'Electrocardiograma',
  'electrocardiograma',
  'anticoagulante',
  'alergia',
  'Diagnóstico',
];
let tokenPaths: { confirm: string; cancel: string; reschedule: string; join: string };

beforeAll(async () => {
  const owner = createOwnerDb(inject('ownerUrl'));
  await seedPlatformCatalogs(owner.db);
  await owner.close();
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBookingWorld(runtime, { slug: PLAIN, now: NOW, video: true });
  await world.openLinks();

  demoId = (await createTestTenant(runtime, { slug: DEMO, isDemo: true, billingExempt: true })).id;
  const deps: DemoSeedDeps = {
    withTenant: createWithTenant(runtime.db),
    hasher: createPasswordHasher(),
    keys: world.keys,
    consentText: { textKey: 'consent.data_processing', version: '1' },
    clock: () => NOW,
    documents: { storage: createMemoryObjectStorage(), scanner: createFakeScanner() },
  };
  await seedDemoTenant(deps, demoId);

  const read = await asTenant(runtime, demoId, async (tx) => {
    const links = await tx.select().from(bookingLink);
    const people = await tx.select().from(patient);
    const upcoming = (await tx.select().from(appointment)).filter(
      (row) => row.startsAt.getTime() > NOW.getTime() && row.status === 'scheduled',
    );
    const sessions = await tx
      .select({ appointmentId: videoSession.appointmentId })
      .from(videoSession)
      .where(eq(videoSession.status, 'ready'));
    return { links, people, upcoming, sessions };
  });
  const organization = read.links.find((link) => link.professionalId === null);
  const professional = read.links.find((link) => link.professionalId !== null);
  if (!organization || !professional) throw new Error('the demo has no booking links');
  orgSlug = organization.slug;
  proSlug = professional.slug;
  typeId = professional.typeIds[0] ?? '';
  personal = read.people.flatMap((row) =>
    [row.familyName, row.givenNames, row.nationalId, row.email, row.phone].filter(
      (value): value is string => typeof value === 'string' && value.length > 5,
    ),
  );

  // One link of each kind for an appointment of the demo, and the join link of a virtual one.
  const tokens = createActionTokens({ clock: () => NOW });
  const target = read.upcoming.find(
    (row) => !read.sessions.some((s) => s.appointmentId === row.id),
  );
  const virtual = read.sessions[0];
  if (!target || !virtual) throw new Error('the demo has no appointment to link to');
  const room = await asTenant(runtime, demoId, async (tx) => {
    const [row] = await tx
      .select({ room: appointment.videoRoom })
      .from(appointment)
      .where(eq(appointment.id, virtual.appointmentId));
    return row?.room ?? '';
  });
  const issue = (
    kind: Parameters<typeof tokens.issue>[1]['kind'],
    subjectId: string,
    payload = {},
  ) =>
    asTenant(runtime, demoId, async (tx) => {
      const issued = await tokens.issue(tx, {
        kind,
        subjectId,
        payload,
        ttlMs: 7 * 24 * 3_600_000,
      });
      return issued.token;
    });
  const forAppointment = { patientId: target.patientId, version: target.version };
  tokenPaths = {
    confirm: `/public/t/${await issue('appointment_confirm', target.id, forAppointment)}`,
    cancel: `/public/t/${await issue('appointment_cancel', target.id, forAppointment)}`,
    reschedule: `/public/t/${await issue('appointment_reschedule', target.id, forAppointment)}`,
    join: `/public/v/${await issue('video_join', virtual.appointmentId, { room })}`,
  };
}, 240_000);

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const get = (path: string, slug = DEMO) =>
  world.app.inject({
    method: 'GET',
    url: path,
    headers: { host: hostOf(slug), 'user-agent': 'vitest-visitor' },
    remoteAddress: '10.88.0.1',
  });

/** Every public page and answer the demonstration organization has, by name. */
function publicGets(): { name: string; path: string; html: boolean }[] {
  const from = '2031-05-12';
  const to = '2031-05-18';
  return [
    { name: 'boot', path: '/public/boot', html: false },
    { name: 'challenge', path: '/public/challenge', html: false },
    { name: 'organization page', path: `/public/${orgSlug}/booking`, html: false },
    { name: 'professional page', path: `/public/${orgSlug}/p/${proSlug}`, html: false },
    {
      name: 'availability',
      path: `/public/${orgSlug}/booking/availability?professional=${proSlug}&typeId=${typeId}&from=${from}&to=${to}`,
      html: false,
    },
    { name: 'confirm link', path: tokenPaths.confirm, html: true },
    { name: 'cancel link', path: tokenPaths.cancel, html: true },
    { name: 'manage data', path: `${tokenPaths.reschedule}/appointment`, html: false },
    {
      name: 'manage slots',
      path: `${tokenPaths.reschedule}/slots?from=${from}&to=${to}`,
      html: false,
    },
    { name: 'video join (early)', path: tokenPaths.join, html: true },
    { name: 'dead link', path: `/public/t/${'a'.repeat(43)}`, html: true },
  ];
}

describe('what every public answer carries', () => {
  it('has the pages the probes below depend on', async () => {
    for (const probe of publicGets()) {
      const response = await get(probe.path);
      expect(response.statusCode, `${probe.name}: ${response.body.slice(0, 200)}`).toBeLessThan(
        probe.name === 'dead link' ? 405 : 400,
      );
    }
  });

  it('is never framed, sniffed, shared across origins or kept by a cache', async () => {
    for (const probe of publicGets()) {
      const { headers } = await get(probe.path);

      expect(headers['x-content-type-options'], probe.name).toBe('nosniff');
      expect(headers['x-frame-options'], probe.name).toBe('DENY');
      expect(headers['cross-origin-resource-policy'], probe.name).toBe('same-origin');
      expect(headers['strict-transport-security'], probe.name).toContain('max-age=');
      // The boot document is revalidated with an ETag by design; everything else is never kept.
      expect(headers['cache-control'], probe.name).toBe(
        probe.name === 'boot' ? 'public, no-cache' : 'no-store',
      );
    }
  });

  it('forbids framing in its policy, and lets no page load anything it did not ship', async () => {
    for (const probe of publicGets()) {
      const policy = String((await get(probe.path)).headers['content-security-policy']);

      expect(policy, probe.name).toContain("frame-ancestors 'none'");
      expect(policy, probe.name).toContain("default-src 'none'");
      expect(policy, probe.name).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
      expect(policy, probe.name).not.toMatch(/script-src/);
    }
  });

  it('keeps the address of a link at home: the pages of the router post to themselves, the rest send no referrer', async () => {
    for (const probe of publicGets()) {
      const response = await get(probe.path);
      const servedByRouter = /^\/public\/t\/[^/]+$/.test(probe.path);

      expect(response.headers['referrer-policy'], probe.name).toBe(
        servedByRouter ? 'same-origin' : 'no-referrer',
      );
      // A page that posts to an address of its own origin, never to another one.
      if (/<form\b/i.test(response.body)) {
        expect(response.body, probe.name).toMatch(/<form[^>]*method="post"/i);
        expect(response.body, probe.name).not.toMatch(/<form[^>]*action="https?:/i);
      }
    }
  });

  it('serves no script, no inline handler and no outside resource in a page', async () => {
    for (const probe of publicGets().filter((entry) => entry.html)) {
      const { body } = await get(probe.path);

      expect(body, probe.name).not.toMatch(/<script/i);
      expect(body, probe.name).not.toMatch(/\son[a-z]+\s*=/i);
      expect(body, probe.name).not.toMatch(
        /<(img|link|iframe|object|embed)[^>]+(src|href)="https?:/i,
      );
    }
  });

  it('tells search engines to leave the pages of a link alone', async () => {
    for (const path of [tokenPaths.confirm, tokenPaths.cancel, `/public/t/${'a'.repeat(43)}`]) {
      expect((await get(path)).headers['x-robots-tag']).toBe('noindex, nofollow');
    }
  });
});

describe('what a public answer says about people', () => {
  it('names no patient, document, address, phone or note, in any page or answer', async () => {
    expect(personal.length).toBeGreaterThan(60);
    for (const probe of publicGets()) {
      const { body } = await get(probe.path);

      for (const value of personal) expect(body, `${probe.name}: ${value}`).not.toContain(value);
      for (const word of CLINICAL) expect(body, `${probe.name}: ${word}`).not.toContain(word);
    }
  });

  it('names only the date, the time, the place and the professional of an appointment', async () => {
    const page = await get(tokenPaths.confirm);

    expect(page.body).toContain('<dt>Hora</dt>');
    expect(page.body).toContain('<dt>Lugar</dt>');
    expect(page.body).not.toMatch(/<dt>(Paciente|Documento|Teléfono|Correo|Motivo|Cobertura)/i);
  });

  it('never shows the address of the video provider before the call may be joined', async () => {
    const { body, statusCode } = await get(tokenPaths.join);

    expect(statusCode).toBe(200);
    expect(body).not.toMatch(/video\.example\.invalid|meet\.jit\.si|https?:\/\/(?!consultorio)/i);
  });

  it('shows the offer pages of the organization without a patient in them', async () => {
    const organization = await get(`/public/${orgSlug}/booking`);
    const professional = await get(`/public/${orgSlug}/p/${proSlug}`);

    for (const response of [organization, professional]) {
      expect(response.statusCode).toBe(200);
      expect(JSON.stringify(response.json())).not.toMatch(/patient|paciente|document|email|phone/i);
    }
  });
});

describe('what changes state must come from the page itself', () => {
  const concrete = (route: string) =>
    route
      .replace(':slug', orgSlug)
      .replace(':professionalSlug', proSlug)
      .replace(':id', '0190a000-0000-7000-8000-000000000001')
      .replace(':token', 'x'.repeat(43));

  const postRoutes = () =>
    [...world.app.routeAuth]
      .filter(([route, auth]) => auth === 'public' && route.startsWith('POST /public/'))
      .map(([route]) => concrete(route.slice('POST '.length)))
      .sort();

  const post = (path: string, headers: Record<string, string>) =>
    world.app.inject({
      method: 'POST',
      url: path,
      headers: {
        host: hostOf(DEMO),
        'user-agent': 'vitest-visitor',
        'content-type': 'application/json',
        ...headers,
      },
      payload: '{}',
      remoteAddress: '10.88.0.2',
    });

  it('has public POST routes to probe (the enumeration is not silently empty)', () => {
    expect(postRoutes().length).toBeGreaterThanOrEqual(10);
  });

  it('refuses a request from another origin on every public POST route', async () => {
    for (const path of postRoutes()) {
      const response = await post(path, { origin: 'https://evil.example' });

      expect(response.statusCode, path).toBe(403);
      expect(response.json<{ code: string }>().code, path).toBe('forbidden');
    }
  });

  it('refuses an origin that only looks like the host', async () => {
    for (const origin of [
      `https://${hostOf(DEMO)}.evil.example`,
      `https://evil.example/${hostOf(DEMO)}`,
      `https://x${hostOf(DEMO)}`,
      'null',
    ]) {
      const response = await post(`/public/${orgSlug}/booking/holds`, { origin });
      expect(response.statusCode, origin).toBe(403);
    }
  });

  it('refuses a request that carries a session cookie and no origin', async () => {
    for (const path of postRoutes()) {
      const response = await post(path, { cookie: `__Host-sid=${'s'.repeat(43)}` });

      expect(response.statusCode, path).toBe(403);
    }
  });

  it('lets the page of the same host through to the rules of the route', async () => {
    for (const path of postRoutes()) {
      const response = await post(path, { origin: `https://${hostOf(DEMO)}` });

      const code = response.statusCode === 403 ? response.json<{ code: string }>().code : '';
      expect(code, path).not.toBe('forbidden');
      expect(response.statusCode, path).toBeLessThan(500);
    }
  });

  it('applies the same rule on the other host names the application answers on', async () => {
    const response = await world.app.inject({
      method: 'POST',
      url: `/public/${orgSlug}/booking/holds`,
      headers: { host: `unknown.${BASE_DOMAIN}`, origin: 'https://evil.example' },
      payload: '{}',
    });

    // The host guard answers first when nothing lives on the host; either way, nothing is done.
    expect([403, 404]).toContain(response.statusCode);
  });
});
