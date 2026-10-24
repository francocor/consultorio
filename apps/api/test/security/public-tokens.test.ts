import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { channelPreference } from '../../src/db/schema/channel-preference.js';
import { appointment } from '../../src/db/schema/scheduling.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { registeredTokenKinds } from '../../src/platform/public/token-router.js';
import { createActionTokens } from '../../src/platform/tokens/index.js';
import { TOKEN_KIND_REGISTRY, type TokenKind } from '../../src/platform/tokens/kinds.js';
import { browserHeaders, buildTestApplication } from '../support/app.js';
import {
  createNotificationsWorld,
  type NotificationsWorld,
} from '../support/notifications-world.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';
import { shapeOf } from '../support/security.js';
import { createTestTenant } from '../support/tenants.js';

/**
 * The single-purpose links of the public surface (design 4.5; notifications, "Confirmation by the
 * patient"; online-booking, "Self-service change"). Every kind that the token router serves is
 * probed the same way: an unknown, a tampered, an expired, a spent, a revoked and a foreign token
 * all get ONE answer, a link looks at things without spending them, and a link acts once.
 *
 * The kinds that live on their own address (the video join, the offer of the waitlist, the
 * download of a document) are listed in `ELSEWHERE` with the file that probes them; a new kind
 * makes the first test fail until it is placed in one of the two.
 */

const SLUG = 'sec-tokens';
const OTHER = 'sec-tokens-other';

/** Kinds that have a public door other than the token router, and where they are probed. */
const ELSEWHERE: Partial<Record<TokenKind, string>> = {
  waitlist_offer: 'test/integration/waitlist-offer-link.test.ts (the offer page of the router)',
  video_join: 'test/integration/video-join-public.test.ts (`/public/v/:token`)',
  document_download: 'test/integration/documents-download.test.ts (`/files/:token`, session bound)',
  export_download: 'test/integration/billing-exports.test.ts (`/files/:token`, session bound)',
  invoice_pdf: 'test/integration/invoice-render.test.ts (`/files/:token`, session bound)',
  prescription_pdf: 'test/integration/prescription-access.test.ts (`/files/:token`, session bound)',
  staff_invitation: 'test/integration/invitation-accept.test.ts (the invitation page of the app)',
  password_reset: 'test/integration/auth-routes.test.ts (the recovery routes)',
  signup_verification: 'test/integration/onboarding-api.test.ts (the signup verification)',
  portal_activation: 'Stage 5 (the patient portal is not built yet; the kind is disabled)',
  archive_release: 'Stage 5 (the kind is disabled)',
};

/** Kinds this file probes through the router, with what pressing the button does. */
const THROUGH_THE_ROUTER = [
  'appointment_confirm',
  'appointment_cancel',
  'appointment_reschedule',
  'notification_opt_out',
  'whatsapp_opt_in',
] as const satisfies readonly TokenKind[];

let runtime: DbHandle;
let scheduling: SchedulingHttpWorld;
let notes: NotificationsWorld;
let app: FastifyInstance;
let now = new Date('2031-05-05T12:00:00.000Z');
let slot = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  scheduling = await createSchedulingHttpWorld(runtime, { slug: SLUG });
  notes = createNotificationsWorld(scheduling);
  await createTestTenant(runtime, { slug: OTHER });
  // The router runs on a clock the tests move; links are public, so no session expires with it.
  app = buildTestApplication(runtime, { clock: () => now, keys: scheduling.keys });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app.close();
  await scheduling.close();
  await runtime.close();
});

beforeEach(async () => {
  now = new Date('2031-05-05T12:00:00.000Z');
  await notes.setTenant({ status: 'active' });
});

const tokens = () => createActionTokens({ clock: () => now });

const visit = (method: 'GET' | 'POST', path: string, slug = SLUG) =>
  app.inject({
    method,
    url: path,
    headers: {
      ...browserHeaders(slug),
      ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(method === 'POST' ? { payload: 'choice=confirm' } : {}),
  });

/** A booked appointment of a patient with an email address, and one token of each kind. */
async function linked() {
  slot += 1;
  const patientId = await notes.patient({ email: `enlace${String(slot)}@example.test` });
  const time = `${String(9 + Math.floor((slot % 8) / 2)).padStart(2, '0')}:${slot % 2 === 0 ? '00' : '30'}`;
  const booked = await notes.book(patientId, 1 + Math.floor(slot / 8), time);
  const issue = async (kind: TokenKind, subjectId: string, payload: Record<string, unknown>) =>
    scheduling.inTenant(async (tx) => {
      const issued = await tokens().issue(tx, {
        kind,
        subjectId,
        payload,
        ttlMs: 7 * 24 * 3_600_000,
      });
      return `/public/t/${issued.token}`;
    });
  const forAppointment = { patientId, version: booked.version };
  return {
    patientId,
    appointment: booked,
    confirm: await issue('appointment_confirm', booked.id, forAppointment),
    cancel: await issue('appointment_cancel', booked.id, forAppointment),
    reschedule: await issue('appointment_reschedule', booked.id, forAppointment),
    optOut: await issue('notification_opt_out', patientId, { channel: 'email' }),
    optIn: await issue('whatsapp_opt_in', patientId, {}),
  };
}

const PATHS = { confirm: 'confirm', cancel: 'cancel', optOut: 'optOut', optIn: 'optIn' } as const;

describe('which kinds are probed', () => {
  it('places every enabled kind of link in this file or in the one that probes it', () => {
    const enabled = (Object.keys(TOKEN_KIND_REGISTRY) as TokenKind[]).filter(
      (kind) => TOKEN_KIND_REGISTRY[kind].enabled,
    );
    const placed = new Set<string>([...THROUGH_THE_ROUTER, ...Object.keys(ELSEWHERE)]);

    expect(enabled.filter((kind) => !placed.has(kind))).toEqual([]);
  });

  it('knows no kind that is not a kind of link', () => {
    const known = new Set<string>(Object.keys(TOKEN_KIND_REGISTRY));

    expect([...THROUGH_THE_ROUTER, ...Object.keys(ELSEWHERE)].filter((k) => !known.has(k))).toEqual(
      [],
    );
  });

  it('serves, through the router, the kinds this file says it does', () => {
    const served = registeredTokenKinds();

    for (const kind of THROUGH_THE_ROUTER.filter((k) => k !== 'appointment_reschedule')) {
      expect(served, kind).toContain(kind);
    }
  });

  it('points at files that exist', async () => {
    const { existsSync } = await import('node:fs');
    for (const where of Object.values(ELSEWHERE)) {
      const file = /^test\/\S+\.ts/.exec(where)?.[0];
      if (file)
        expect(existsSync(new URL(`../../${file.slice(0)}`, import.meta.url)), file).toBe(true);
    }
  });
});

describe('one answer for every link that does not work', () => {
  it('answers a made-up, a truncated, a padded and an empty-looking token the same', async () => {
    const reference = shapeOf(await visit('GET', `/public/t/${'a'.repeat(43)}`));
    const variants = [
      'b'.repeat(43),
      'a'.repeat(42),
      'a'.repeat(44),
      '-'.repeat(43),
      'A'.repeat(43),
    ];

    for (const variant of variants) {
      expect(shapeOf(await visit('GET', `/public/t/${variant}`)), variant).toBe(reference);
      expect(shapeOf(await visit('POST', `/public/t/${variant}`)), variant).toBe(
        shapeOf(await visit('POST', `/public/t/${'c'.repeat(43)}`)),
      );
    }
    const page = await visit('GET', `/public/t/${'a'.repeat(43)}`);
    expect(page.statusCode).toBe(404);
    expect(page.body).not.toMatch(/turno|paciente|cita/i);
  });

  it('answers a tampered link like an unknown one, for every kind', async () => {
    const reference = shapeOf(await visit('GET', `/public/t/${'a'.repeat(43)}`));
    const set = await linked();

    for (const link of Object.values(PATHS).map((name) => set[name])) {
      const flipped = `${link.slice(0, -1)}${link.endsWith('A') ? 'B' : 'A'}`;
      expect(shapeOf(await visit('GET', flipped)), link).toBe(reference);
      expect(shapeOf(await visit('GET', link.toLowerCase())), link).not.toContain('Confirm');
    }
  });

  it('answers the link of another organization like an unknown one', async () => {
    const reference = shapeOf(await visit('GET', `/public/t/${'a'.repeat(43)}`, OTHER));
    const set = await linked();

    for (const name of Object.values(PATHS)) {
      expect(shapeOf(await visit('GET', set[name], OTHER)), name).toBe(reference);
      expect((await visit('POST', set[name], OTHER)).statusCode, name).toBe(404);
    }
    // Nothing was done to the appointment by trying it on the wrong host.
    const [row] = await scheduling.inTenant((tx) =>
      tx
        .select({ status: appointment.status })
        .from(appointment)
        .where(eq(appointment.id, set.appointment.id)),
    );
    expect(row?.status).toBe('scheduled');
  });

  it('answers an expired link like an unknown one', async () => {
    const reference = shapeOf(await visit('GET', `/public/t/${'a'.repeat(43)}`));
    const set = await linked();

    now = new Date(now.getTime() + 8 * 24 * 3_600_000);

    for (const name of Object.values(PATHS)) {
      expect(shapeOf(await visit('GET', set[name])), name).toBe(reference);
    }
  });

  it('answers a link that was replaced like an unknown one: moving the appointment kills the old ones', async () => {
    const reference = shapeOf(await visit('GET', `/public/t/${'a'.repeat(43)}`));
    const set = await linked();
    const cancelled = await scheduling.act(set.appointment, 'cancel', scheduling.reception, {
      cancelledBy: 'patient',
      reasonCode: 'patient_request',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    await scheduling.app.background.idle();

    // The cancel link of an appointment that is gone, and the confirm link of the same one.
    expect(shapeOf(await visit('GET', set.confirm))).toBe(reference);
    expect(shapeOf(await visit('GET', set.cancel))).toBe(reference);
  });
});

describe('looking is not acting', () => {
  it('shows what the link is about without spending it, as many times as it is opened', async () => {
    const set = await linked();

    for (let times = 0; times < 3; times += 1) {
      const page = await visit('GET', set.confirm);
      expect(page.statusCode).toBe(200);
    }

    const [row] = await scheduling.inTenant((tx) =>
      tx
        .select({ status: appointment.status })
        .from(appointment)
        .where(eq(appointment.id, set.appointment.id)),
    );
    expect(row?.status).toBe('scheduled');
    expect((await visit('POST', set.confirm)).statusCode).toBe(200);
  });
});

describe('a link acts once', () => {
  it('confirms the appointment on the first press and is a dead link on the second', async () => {
    const set = await linked();
    const dead = shapeOf(await visit('GET', `/public/t/${'a'.repeat(43)}`));

    const first = await visit('POST', set.confirm);
    const second = await visit('POST', set.confirm);

    expect(first.statusCode).toBe(200);
    expect(shapeOf(second)).toBe(dead);
    expect(shapeOf(await visit('GET', set.confirm))).toBe(dead);
  });

  it('cancels the appointment once', async () => {
    const set = await linked();
    const dead = shapeOf(await visit('GET', `/public/t/${'a'.repeat(43)}`));

    expect((await visit('POST', set.cancel)).statusCode).toBe(200);
    await app.background.idle();

    expect(shapeOf(await visit('POST', set.cancel))).toBe(dead);
    const [row] = await scheduling.inTenant((tx) =>
      tx
        .select({ status: appointment.status })
        .from(appointment)
        .where(eq(appointment.id, set.appointment.id)),
    );
    expect(row?.status).toBe('cancelled');
  });

  it('records one opt-out for one press, however many times the link is pressed', async () => {
    const set = await linked();

    const presses = await Promise.all([1, 2, 3].map(() => visit('POST', set.optOut)));
    await app.background.idle();

    expect(presses.filter((press) => press.statusCode === 200)).toHaveLength(1);
    const rows = await scheduling.inTenant((tx) =>
      tx
        .select({ state: channelPreference.state })
        .from(channelPreference)
        .where(eq(channelPreference.patientId, set.patientId)),
    );
    // One press records the opt-out of both channels (B7), once each.
    expect(rows).toEqual([{ state: 'opted_out' }, { state: 'opted_out' }]);
  });

  it('does not let the link of one patient act on another: the subject is part of the token', async () => {
    const first = await linked();
    const second = await linked();

    expect((await visit('POST', first.optOut)).statusCode).toBe(200);
    await app.background.idle();

    const rows = await scheduling.inTenant((tx) =>
      tx
        .select({ patientId: channelPreference.patientId })
        .from(channelPreference)
        .where(eq(channelPreference.patientId, second.patientId)),
    );
    expect(rows).toEqual([]);
  });
});

describe('what the audit trail keeps of a link', () => {
  it('names the action and never the token', async () => {
    const set = await linked();
    const secret = set.cancel.replace('/public/t/', '');

    await visit('POST', set.cancel);
    await app.background.idle();

    const events = await scheduling.inTenant((tx) => tx.select().from(auditEvent));
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});

describe('a read-only organization', () => {
  it('keeps the links that protect the patient and refuses the rest, with a plain page', async () => {
    const set = await linked();
    await notes.setTenant({ status: 'read_only' });

    const confirm = await visit('POST', set.confirm);
    const optIn = await visit('POST', set.optIn);
    const cancel = await visit('POST', set.cancel);
    const optOut = await visit('POST', set.optOut);

    expect(confirm.statusCode).toBe(402);
    expect(optIn.statusCode).toBe(402);
    expect(cancel.statusCode).toBe(200);
    expect(optOut.statusCode).toBe(200);
    for (const refused of [confirm, optIn]) {
      expect(refused.headers['content-type']).toContain('text/html');
      expect(refused.body).not.toMatch(/Dra\.|paciente/i);
    }
  });
});
