import type { PublicHoldDto } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createAbuse } from '../../src/modules/online-booking/application/abuse.js';
import type { BookingNotifier } from '../../src/modules/online-booking/application/booking-notifier.js';
import {
  confirmBooking,
  type ConfirmDeps,
} from '../../src/modules/online-booking/application/confirm-booking.js';
import { sourceKeyOf } from '../../src/modules/online-booking/application/public-holds.js';
import { createScheduling, createSchedulingPorts } from '../../src/modules/scheduling/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { createMemoryRateLimitStore } from '../../src/platform/http/rate-limit.js';
import { createMetrics } from '../../src/platform/metrics.js';
import { createActionTokens } from '../../src/platform/tokens/index.js';
import { createBookingWorld, type BookingWorld, type Visitor } from '../support/booking-world.js';

/**
 * The WhatsApp choice of the form (online-booking, "WhatsApp opt-in at booking"). A number typed
 * into a public form is not verified, so the choice is only a REQUEST (decision D22): the
 * notifications module hands out a link, which goes in the confirmation to the verified address,
 * and the opt-in is recorded when the patient follows it. Online booking asks through a port, and
 * only for a patient that this very booking created: a record nobody has checked never gets a
 * request from whoever typed a document that happens to match it.
 */
let runtime: DbHandle;
let world: BookingWorld;
let links: Awaited<ReturnType<BookingWorld['openLinks']>>;
const optIns: { patientId: string; at: Date }[] = [];
const notices: { whatsappOptInToken: string | null }[] = [];

const EARLY = new Date('2031-05-05T12:00:00.000Z');

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createBookingWorld(runtime, { slug: 'booking-optin' });
  links = await world.openLinks();
  await world.api.patch('/settings', world.owner, { onlineBooking: { horizonDays: 365 } });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

let week = 0;

/** Confirms a submitted form through the use case, with a notifier that records the opt-ins. */
async function confirmed(options: {
  whatsappOptIn: boolean;
  document?: { type: 'dni'; number: string };
}) {
  world.setNow(EARLY);
  week += 1;
  const visitor: Visitor = world.visitor();
  const hold: PublicHoldDto = await world.hold(visitor, links, { weeksAfter: week });
  const form = world.form({
    whatsappOptIn: options.whatsappOptIn,
    phone: '+54 11 5555 0000',
    ...(options.document ? { document: options.document } : {}),
  });
  const submitted = await visitor.post(
    `/public/${links.organization.slug}/booking/holds/${hold.id}/submission`,
    { ...form, challengeProof: await visitor.solve() },
  );
  expect(submitted.statusCode, submitted.body).toBe(200);
  await world.runJobs();

  const notifier: BookingNotifier = {
    requestWhatsAppOptIn: (_tx, input) => {
      optIns.push(input);
      return Promise.resolve({ token: 'OPT-IN-TOKEN' });
    },
    confirmBooking: () => Promise.resolve(),
  };
  const keys = world.keys;
  const withTenant = createWithTenant(runtime.db);
  const scheduling = createScheduling({
    withTenant,
    auditDeny: () => Promise.resolve({ recorded: true }),
    keys,
  });
  const portsOf: ConfirmDeps['portsOf'] = (tx) => createSchedulingPorts(tx, { keys });
  const deps: ConfirmDeps = {
    keys,
    worklist: scheduling.worklist,
    tokens: createActionTokens({ clock: () => world.now() }),
    notifier,
    abuse: createAbuse({ store: createMemoryRateLimitStore(), metrics: createMetrics() }),
    portsOf,
  };
  const sessionId = visitor.cookie().split('=')[1] ?? '';
  const outcome = await withTenant(
    { tenantId: world.tenant.id, userId: world.owner.user.id },
    (tx) =>
      confirmBooking(tx, deps, {
        tenant: { id: world.tenant.id, country: 'AR', slug: world.slug, isDemo: false },
        organizationSlug: links.organization.slug,
        holdId: hold.id,
        sourceKey: sourceKeyOf(sessionId),
        ip: visitor.ip,
        actor: { userId: null, actingRole: null, ip: null, userAgent: null, requestId: null },
        now: world.now(),
        offerContext: { now: world.now(), videoAvailable: false, horizonDays: 365, portsOf },
        code: world.codeSentTo(form.email),
      }),
  );
  expect(outcome.ok).toBe(true);
  if (outcome.ok) notices.push(outcome.notice);
  return form;
}

describe('the WhatsApp choice at booking', () => {
  it('asks for an opt-in, with the time, for the patient this booking created, and puts its link in the notice', async () => {
    optIns.length = 0;
    notices.length = 0;

    const form = await confirmed({ whatsappOptIn: true });

    expect(notices.at(-1)?.whatsappOptInToken).toBe('OPT-IN-TOKEN');
    expect(optIns).toHaveLength(1);
    expect(optIns[0]?.at).toEqual(world.now());
    const [created] = await world
      .inTenant((tx) =>
        tx.execute<{ id: string }>(
          sql`SELECT id FROM patient WHERE national_id = ${form.document.number}`,
        ),
      )
      .then((result) => result.rows);
    expect(optIns[0]?.patientId).toBe(created?.id);
  });

  it('asks for nothing when the box stays unticked', async () => {
    optIns.length = 0;

    notices.length = 0;
    await confirmed({ whatsappOptIn: false });

    expect(optIns).toEqual([]);
    expect(notices.at(-1)?.whatsappOptInToken).toBeNull();
  });

  it('asks for nothing on a record the organization already had, whoever ticked the box', async () => {
    optIns.length = 0;
    await world.inTenant((tx) =>
      tx.execute(
        sql`INSERT INTO patient (tenant_id, family_name, given_names, birth_date, national_id_type, national_id)
              VALUES (${world.tenant.id}, 'Existente', 'Eva', '1975-03-03', 'dni', '31000999')`,
      ),
    );

    notices.length = 0;
    await confirmed({ whatsappOptIn: true, document: { type: 'dni', number: '31000999' } });

    expect(optIns).toEqual([]);
    expect(notices.at(-1)?.whatsappOptInToken).toBeNull();
  });
});
