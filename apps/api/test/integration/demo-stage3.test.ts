import { randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFakeScanner } from '../../src/adapters/fake-scanner/index.js';
import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { createMemoryObjectStorage } from '../../src/adapters/memory-storage/index.js';
import { seedDemoTenant, type DemoSeedDeps } from '../../src/db/seed/demo/seed.js';
import { snapshotDemoStage3 } from '../../src/db/seed/demo/stage3/snapshot.js';
import { seedPlatformCatalogs } from '../../src/db/seed/platform.js';
import { createPasswordHasher } from '../../src/modules/identity/infrastructure/argon2.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createOwnerDb, createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, SYSTEM_USER_ID } from '../../src/platform/db/tenant-context.js';
import { createTestTenant } from '../support/tenants.js';

/**
 * What the Stage 3 demo seed leaves in a demonstration organization (tasks 3.71 and 3.72): the
 * message log and the choices of the patients, the public booking links with their online
 * bookings, the waitlist and the virtual appointments. All of it is plain data: a demonstration
 * organization never sends a message, and two seeds give the same logical content.
 */

let runtime: DbHandle;
let deps: DemoSeedDeps;
const clock = () => new Date('2026-03-02T12:00:00Z');
let first: string;
let second: string;

const rows = <T extends Record<string, unknown>>(tenantId: string, query: ReturnType<typeof sql>) =>
  deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const result = await tx.execute<T>(query);
    return result.rows;
  });

beforeAll(async () => {
  const owner = createOwnerDb(inject('ownerUrl'));
  await seedPlatformCatalogs(owner.db);
  await owner.close();
  runtime = createRuntimeDb(inject('runtimeUrl'));
  deps = {
    withTenant: createWithTenant(runtime.db),
    hasher: createPasswordHasher(),
    keys: createTenantKeys({ kms: createLocalKeyManagement(randomBytes(32).toString('base64')) }),
    consentText: { textKey: 'consent.data_processing', version: '1' },
    clock,
    documents: { storage: createMemoryObjectStorage(), scanner: createFakeScanner() },
  };
  first = (await createTestTenant(runtime, { slug: 'stage3-a', isDemo: true, billingExempt: true }))
    .id;
  second = (
    await createTestTenant(runtime, { slug: 'stage3-a2', isDemo: true, billingExempt: true })
  ).id;
  await seedDemoTenant(deps, first);
  await seedDemoTenant(deps, second);
}, 240_000);

afterAll(async () => {
  await runtime.close();
});

describe('the public booking of the demonstration organization', () => {
  it('has an enabled link for the organization and one for each professional, ready for a QR code', async () => {
    const links = await rows<{ professional: string | null; slug: string; enabled: boolean }>(
      first,
      sql`SELECT m.display_name AS professional, l.slug, l.enabled
            FROM booking_link l
            LEFT JOIN professional p ON p.id = l.professional_id
            LEFT JOIN membership m ON m.id = p.membership_id
           ORDER BY m.display_name NULLS FIRST`,
    );

    expect(links).toHaveLength(4);
    expect(links.every((link) => link.enabled)).toBe(true);
    expect(links[0]?.professional).toBeNull();
    for (const link of links) expect(link.slug).toMatch(/^[a-z0-9]{12}$/);
  });

  it('exposes the types of visit of each professional, the virtual one included', async () => {
    const exposed = await rows<{ kinds: number; virtual: number }>(
      first,
      sql`SELECT cardinality(l.type_ids)::int AS kinds,
                 (SELECT count(*)::int FROM appointment_type t
                   WHERE t.id = ANY (l.type_ids) AND t.mode = 'virtual') AS virtual
            FROM booking_link l WHERE l.professional_id IS NOT NULL`,
    );

    expect(exposed).toHaveLength(3);
    for (const link of exposed) {
      expect(link.kinds).toBeGreaterThan(0);
      expect(link.virtual).toBe(1);
    }
  });

  it('shows online bookings: one confirmed, one waiting for approval, one waiting for an identity review', async () => {
    const online = await rows<{
      status: string;
      identity_confirmed: boolean;
      origin: string;
      pending_approval: number;
      identity_review: number;
    }>(
      first,
      sql`SELECT a.status, a.identity_confirmed, p.origin,
                 (SELECT count(*)::int FROM worklist_item w
                   WHERE w.subject_id = a.id AND w.kind = 'pending_approval' AND w.status = 'open') AS pending_approval,
                 (SELECT count(*)::int FROM worklist_item w
                   WHERE w.subject_id = a.id AND w.kind = 'identity_review' AND w.status = 'open') AS identity_review
            FROM appointment a JOIN patient p ON p.id = a.patient_id
           WHERE a.source = 'online' ORDER BY a.starts_at`,
    );

    expect(online).toHaveLength(3);
    expect(online.filter((row) => row.status === 'pending_approval')).toHaveLength(1);
    expect(online.find((row) => row.status === 'pending_approval')?.pending_approval).toBe(1);
    const review = online.filter((row) => !row.identity_confirmed);
    expect(review).toHaveLength(1);
    expect(review[0]?.identity_review).toBe(1);
    // The patient of a review already existed; the other two registered themselves online.
    expect(review[0]?.origin).not.toBe('online');
    expect(online.filter((row) => row.origin === 'online')).toHaveLength(2);
  });

  it('leaves no unverified form, code or hold behind: those live for minutes or hours', async () => {
    const [counts] = await rows<{ submissions: number; codes: number }>(
      first,
      sql`SELECT (SELECT count(*)::int FROM booking_submission WHERE status = 'unverified') AS submissions,
                 (SELECT count(*)::int FROM otp_challenge) AS codes`,
    );

    expect(counts).toEqual({ submissions: 0, codes: 0 });
  });
});

describe('the virtual appointments of the demonstration organization', () => {
  it('has video sessions: one ready with its room and one waiting for a manual link', async () => {
    const sessions = await rows<{
      status: string;
      pending_reason: string | null;
      provider: string | null;
      has_room: boolean;
      mode: string;
    }>(
      first,
      sql`SELECT s.status, s.pending_reason, s.provider, (a.video_room IS NOT NULL) AS has_room, t.mode
            FROM video_session s
            JOIN appointment a ON a.id = s.appointment_id
            JOIN appointment_type t ON t.id = a.appointment_type_id
           ORDER BY s.status`,
    );

    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.every((session) => session.mode === 'virtual')).toBe(true);
    const ready = sessions.filter((session) => session.status === 'ready');
    expect(ready.length).toBeGreaterThanOrEqual(1);
    expect(ready.every((session) => session.has_room && session.provider === 'fake')).toBe(true);
    const waiting = sessions.filter((session) => session.status === 'link_pending');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.pending_reason).toBe('provider_failed');
  });

  it('only names rooms the providers could have made: 128 random bits in hexadecimal', async () => {
    const rooms = await rows<{ video_room: string }>(
      first,
      sql`SELECT video_room FROM appointment WHERE video_room IS NOT NULL`,
    );

    expect(rooms.length).toBeGreaterThan(0);
    for (const row of rooms) expect(row.video_room).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe('the waitlist of the demonstration organization', () => {
  it('has entries in several states, an open offer and a freed slot to fill by phone', async () => {
    const entries = await rows<{ status: string; manual_contact_only: boolean }>(
      first,
      sql`SELECT status, manual_contact_only FROM waitlist_entry ORDER BY status`,
    );
    const offers = await rows<{ status: string }>(
      first,
      sql`SELECT status FROM waitlist_offer ORDER BY status`,
    );
    const calls = await rows<{ reason: string }>(first, sql`SELECT reason FROM waitlist_call`);

    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries.some((entry) => entry.manual_contact_only)).toBe(true);
    expect(offers.map((offer) => offer.status)).toEqual(
      expect.arrayContaining(['open', 'expired']),
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('shows the open offer as an entry that was offered a slot, and reception the call to make', async () => {
    const [state] = await rows<{ offered: number; calls: number }>(
      first,
      sql`SELECT (SELECT count(*)::int FROM waitlist_entry WHERE status = 'offered') AS offered,
                 (SELECT count(*)::int FROM worklist_item
                   WHERE kind = 'waitlist_manual_contact' AND status = 'open') AS calls`,
    );

    expect(state?.offered).toBe(1);
    expect(state?.calls).toBeGreaterThanOrEqual(1);
  });
});

describe('the message log of the demonstration organization', () => {
  it('has messages in every status, of every kind an appointment sends', async () => {
    const log = await rows<{ kind: string; channel: string; status: string }>(
      first,
      sql`SELECT kind, channel, status FROM message`,
    );

    const statuses = new Set(log.map((row) => row.status));
    for (const status of ['queued', 'sent', 'delivered', 'read', 'failed', 'cancelled']) {
      expect(statuses, status).toContain(status);
    }
    const kinds = new Set(log.map((row) => row.kind));
    for (const kind of ['reminder', 'confirmation', 'waitlist_offer', 'video_link']) {
      expect(kinds, kind).toContain(kind);
    }
    expect(new Set(log.map((row) => row.channel))).toEqual(new Set(['email', 'whatsapp']));
  });

  it('writes to WhatsApp only for patients who opted in, and never to one who opted out of email by email', async () => {
    const wrong = await rows<{ id: string }>(
      first,
      sql`SELECT m.id FROM message m
           WHERE m.channel = 'whatsapp'
             AND NOT EXISTS (
               SELECT 1 FROM channel_preference c
                WHERE c.patient_id = m.patient_id AND c.channel = 'whatsapp' AND c.state = 'opted_in')`,
    );
    const afterOptOut = await rows<{ id: string }>(
      first,
      sql`SELECT m.id FROM message m
           WHERE m.status IN ('sent', 'delivered', 'read')
             AND EXISTS (
               SELECT 1 FROM channel_preference c
                WHERE c.patient_id = m.patient_id AND c.channel = m.channel
                  AND c.state = 'opted_out' AND c.created_at < m.sent_at)`,
    );

    expect(wrong).toEqual([]);
    expect(afterOptOut).toEqual([]);
  });

  it('keeps the choices of the patients: opt-ins, an opt-out, and the provider events and replies behind them', async () => {
    const [counts] = await rows<{
      optIns: number;
      optOuts: number;
      events: number;
      inbound: number;
      usage: number;
      attempts: number;
    }>(
      first,
      sql`SELECT (SELECT count(*)::int FROM channel_preference WHERE state = 'opted_in') AS "optIns",
                 (SELECT count(*)::int FROM channel_preference WHERE state = 'opted_out') AS "optOuts",
                 (SELECT count(*)::int FROM message_event) AS events,
                 (SELECT count(*)::int FROM inbound_message) AS inbound,
                 (SELECT count(*)::int FROM whatsapp_usage_event) AS usage,
                 (SELECT count(*)::int FROM message_attempt) AS attempts`,
    );

    expect(counts?.optIns).toBeGreaterThanOrEqual(3);
    expect(counts?.optOuts).toBeGreaterThanOrEqual(1);
    expect(counts?.events).toBeGreaterThan(0);
    expect(counts?.inbound).toBeGreaterThan(0);
    expect(counts?.usage).toBeGreaterThan(0);
    expect(counts?.attempts).toBeGreaterThan(0);
  });

  it('counts WhatsApp usage only for messages the provider accepted, once each', async () => {
    const stray = await rows<{ id: string }>(
      first,
      sql`SELECT e.id FROM whatsapp_usage_event e JOIN message m ON m.id = e.message_id
           WHERE m.channel <> 'whatsapp' OR m.status IN ('queued', 'cancelled', 'failed')`,
    );

    expect(stray).toEqual([]);
  });

  it('does not keep the text of any message, nor an address: only metadata', async () => {
    const [stored] = await rows<{ columns: string[] }>(
      first,
      sql`SELECT array_agg(column_name::text ORDER BY column_name) AS columns
            FROM information_schema.columns WHERE table_name = 'message'`,
    );

    expect(stored?.columns).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^(body|text|subject|to|email|phone)$/)]),
    );
  });
});

describe('the seed is repeatable', () => {
  it('gives two organizations the same logical Stage 3 content', async () => {
    const a = await snapshotDemoStage3(deps.withTenant, first);
    const b = await snapshotDemoStage3(deps.withTenant, second);

    // The addresses of the booking links depend on the organization; everything else is equal.
    expect({ ...a, bookingLinks: a.bookingLinks.length }).toEqual({
      ...b,
      bookingLinks: b.bookingLinks.length,
    });
    expect(a.messages.length).toBeGreaterThan(0);
    expect(a.waitlist.length).toBeGreaterThan(0);
  });
});
