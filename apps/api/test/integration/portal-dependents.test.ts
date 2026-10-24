import type {
  PortalAppointmentsResponse,
  PortalIdentityDto,
  PortalMeResponse,
  PortalRepresentativesResponse,
  Problem,
} from '@consultorio/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createMajorityReviewJob } from '../../src/modules/portal/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import type { Visitor } from '../support/booking-world.js';
import { createPortalWorld, type PortalWorld } from '../support/portal-world.js';

/**
 * Dependents (S5.09, task 5.36): a parent reads the record of a child from their own account, and
 * when the child turns 18 the access is suspended until the adult authorizes it.
 */
let runtime: DbHandle;
let world: PortalWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createPortalWorld(runtime, { slug: 'portal-dependents' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const audits = (action: string) =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, action as never)))
      .orderBy(asc(auditEvent.occurredAt)),
  );

const NOTE = 'Verificado en persona con la partida de nacimiento.';

/** The review of the organization on a given day. */
async function reviewOn(day: string) {
  const job = createMajorityReviewJob({ clock: () => new Date(`${day}T12:00:00.000Z`) });
  return runJob(runtime.db, job, {
    id: crypto.randomUUID(),
    name: job.name,
    data: { tenantId: world.tenant.id },
    enqueuedAt: new Date(),
    retryCount: 0,
  });
}

/**
 * A child who turns 18 on 2031-05-06, with a parent who represents them and, optionally, an
 * account of their own (the child has an email on the record).
 */
async function family(options: { adultAccount?: boolean } = {}) {
  const parentEmail = `padre-${crypto.randomUUID().slice(0, 6)}@example.test`;
  const childEmail = `hijo-${crypto.randomUUID().slice(0, 6)}@example.test`;
  const child = await world.patientWith({ birthDate: '2013-05-06', email: childEmail });
  const parent = await world.inviteOk(child, {
    email: parentEmail,
    relation: 'mother',
    verificationNote: NOTE,
  });
  await world.activate(world.activationPathSentTo(parentEmail));
  let adult: Visitor | undefined;
  if (options.adultAccount === true) {
    // The account the person opened for themselves once they were an adult: the organization cannot
    // invite a minor as themselves (JD-S5 R1-S5-6), so the account is made straight in the database
    // (the clock of the application stays on the day before the birthday in this world).
    await world.inTenant(async (tx) => {
      const identity = await tx.execute<{ id: string }>(
        sql`INSERT INTO portal_identity (tenant_id, email, status, activated_at)
              VALUES (${world.tenant.id}, ${childEmail}, 'active', now()) RETURNING id`,
      );
      await tx.execute(
        sql`INSERT INTO portal_link (tenant_id, portal_identity_id, patient_id, relationship)
              VALUES (${world.tenant.id}, ${identity.rows[0]?.id ?? ''}, ${child}, 'self')`,
      );
    });
    adult = await world.signInAs(childEmail);
  }
  const parentVisitor = await world.signInAs(parentEmail);
  const link = (await world.portalOf(child)).identities
    .flatMap((identity) => identity.links)
    .find((entry) => entry.relationship === 'representative');
  return { child, parent, parentEmail, childEmail, parentVisitor, adult, linkId: link?.id ?? '' };
}

describe('a parent', () => {
  it('reads the record of the child from their own account, with the relation and the header data', async () => {
    const { parentVisitor, child } = await family();
    const booked = await world.book(40, '09:00', { patientId: child });

    const me = (await parentVisitor.get('/portal/me')).json<PortalMeResponse>();
    const appointments = (
      await parentVisitor.get('/portal/appointments')
    ).json<PortalAppointmentsResponse>();

    expect(me.links).toHaveLength(1);
    expect(me.links[0]).toMatchObject({
      patientId: child,
      relationship: 'representative',
      relation: 'mother',
      status: 'active',
      majorityReviewOn: '2031-05-06',
    });
    // One record to read: it is the subject at once.
    expect(me.selectedLinkId).toBe(me.links[0]?.id);
    expect(appointments.upcoming.map((appointment) => appointment.id)).toEqual([booked.id]);
  });
});

describe('the day the child turns 18', () => {
  it('keeps the access the day before and suspends it from the day itself', async () => {
    const { parentVisitor, linkId } = await family();

    const early = await reviewOn('2031-05-05');
    expect(early).toEqual({ status: 'completed' });
    expect((await parentVisitor.get('/portal/appointments')).statusCode).toBe(200);

    const day = await reviewOn('2031-05-06');
    expect(day).toEqual({ status: 'completed' });
    const me = (await parentVisitor.get('/portal/me')).json<PortalMeResponse>();
    expect(me.links[0]).toMatchObject({ id: linkId, status: 'suspended' });
    expect(me.selectedLinkId).toBeNull();
    const blocked = await parentVisitor.get('/portal/appointments');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<Problem>().code).toBe('portal_subject_required');
    // Nor can the suspended link be picked again by the parent.
    const picked = await parentVisitor.post('/portal/subject', { linkId });
    expect(picked.statusCode).toBe(404);
    const rows = (await audits('portal.identity.deactivated')).filter(
      (row) => (row.metadata as { reason?: string }).reason === 'majority',
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ outcome: 'allow', actorUserId: null });
  });

  it("does not touch a representative of a dependent who is still a minor, or a patient's own link", async () => {
    const minorEmail = `menor-${crypto.randomUUID().slice(0, 6)}@example.test`;
    const minor = await world.patientWith({ birthDate: '2024-01-01', email: null });
    await world.inviteOk(minor, { email: minorEmail, relation: 'father', verificationNote: NOTE });
    await world.activate(world.activationPathSentTo(minorEmail));
    const own = await world.patientSession();
    await reviewOn('2031-05-06');

    const mine = (await own.visitor.get('/portal/me')).json<PortalMeResponse>();
    const visitor = await world.signInAs(minorEmail);
    const theirs = (await visitor.get('/portal/me')).json<PortalMeResponse>();

    expect(mine.links[0]?.status).toBe('active');
    expect(theirs.links[0]?.status).toBe('active');
  });

  it('runs in a read-only organization too: it protects the person, whatever the subscription', async () => {
    const { parentVisitor } = await family();
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE tenant SET status = 'read_only', read_only_since = now() WHERE id = ${world.tenant.id}`,
      ),
    );
    try {
      const result = await reviewOn('2031-05-06');

      expect(result).toEqual({ status: 'completed' });
      expect(
        (await parentVisitor.get('/portal/me')).json<PortalMeResponse>().links[0]?.status,
      ).toBe('suspended');
    } finally {
      await world.inTenant((tx) =>
        tx.execute(
          sql`UPDATE tenant SET status = 'active', read_only_since = NULL WHERE id = ${world.tenant.id}`,
        ),
      );
    }
  });
});

describe('the adult', () => {
  it('sees who represented them, authorizes the parent again, and the parent gets the access back', async () => {
    const { parentVisitor, adult, linkId, parentEmail } = await family({ adultAccount: true });
    await reviewOn('2031-05-06');
    const visitor = adult as Visitor;

    const listed = await visitor.get('/portal/representatives');
    expect(listed.statusCode, listed.body).toBe(200);
    const representatives = listed.json<PortalRepresentativesResponse>().representatives;
    expect(representatives).toHaveLength(1);
    expect(representatives[0]).toMatchObject({
      id: linkId,
      relation: 'mother',
      status: 'suspended',
      maskedEmail: `${parentEmail.slice(0, 1)}***@example.test`,
    });
    expect(JSON.stringify(representatives)).not.toContain(parentEmail);

    const authorized = await visitor.post(`/portal/links/${linkId}/authorize`, {});
    expect(authorized.statusCode, authorized.body).toBe(204);

    const me = (await parentVisitor.get('/portal/me')).json<PortalMeResponse>();
    expect(me.links[0]).toMatchObject({ id: linkId, status: 'active', majorityReviewOn: null });
    expect(me.selectedLinkId).toBe(linkId);
    expect((await parentVisitor.get('/portal/appointments')).statusCode).toBe(200);
    // The review does not suspend it again: the date of majority is gone.
    await reviewOn('2031-06-01');
    expect((await parentVisitor.get('/portal/appointments')).statusCode).toBe(200);
    const linked = (await audits('portal.identity.linked')).filter(
      (row) => (row.metadata as { via?: string }).via === 'adult_authorization',
    );
    expect(linked.at(-1)).toMatchObject({ actingRole: 'patient', actorUserId: null });
  });

  it('can end the access of a representative, and their sessions end with it', async () => {
    const { parentVisitor, adult, linkId } = await family({ adultAccount: true });

    const response = await (adult as Visitor).post(`/portal/links/${linkId}/revoke`, {});

    expect(response.statusCode, response.body).toBe(204);
    expect((await parentVisitor.get('/portal/me')).statusCode).toBe(401);
    expect(
      (
        await (adult as Visitor).get('/portal/representatives')
      ).json<PortalRepresentativesResponse>().representatives,
    ).toEqual([]);
  });

  it('is the only one who can: the representative cannot authorize or end their own link, nor a stranger another', async () => {
    const { parentVisitor, linkId } = await family();
    const stranger = await world.patientSession();
    await reviewOn('2031-05-06');
    const before = (await audits('portal.denied')).length;

    const own = await parentVisitor.post(`/portal/links/${linkId}/authorize`, {});
    const ended = await parentVisitor.post(`/portal/links/${linkId}/revoke`, {});
    const foreign = await stranger.visitor.post(`/portal/links/${linkId}/authorize`, {});

    // The parent's own subject is gone once the link is suspended; a stranger finds nothing.
    expect([own.statusCode, ended.statusCode]).toEqual([409, 409]);
    expect(foreign.statusCode).toBe(404);
    expect((await audits('portal.denied')).length).toBeGreaterThan(before);
  });

  it('does not see the representatives of a person they only represent', async () => {
    const { parentVisitor } = await family();

    const response = await parentVisitor.get('/portal/representatives');

    expect(response.json<PortalRepresentativesResponse>().representatives).toEqual([]);
  });
});

describe('the organization', () => {
  it('verifies a suspended representative again only while the person is still a minor, with a new note and a new day of majority', async () => {
    // The job of this test runs on the day of the birthday, but the clock of the application is the
    // day before: the person is still a minor for the organization, which is the case a link
    // suspended in error would be in.
    const { parentVisitor, linkId } = await family();
    await reviewOn('2031-05-06');

    const refused = await world.api.post(`/portal-links/${linkId}/authorize`, world.doctor, {
      verificationNote: 'Verificado otra vez en el mostrador.',
    });
    const noNote = await world.api.post(`/portal-links/${linkId}/authorize`, world.reception, {});
    const done = await world.api.post(`/portal-links/${linkId}/authorize`, world.reception, {
      verificationNote: 'Verificado otra vez en el mostrador.',
    });

    expect(refused.statusCode).toBe(403);
    expect(noNote.statusCode).toBe(400);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json<{ identity: PortalIdentityDto }>().identity.links[0]).toMatchObject({
      status: 'active',
      majorityReviewOn: '2031-05-06',
    });
    expect((await parentVisitor.get('/portal/appointments')).statusCode).toBe(200);
    const again = await world.api.post(`/portal-links/${linkId}/authorize`, world.reception, {
      verificationNote: 'Verificado otra vez en el mostrador.',
    });
    expect(again.statusCode).toBe(409);
  });

  it('can end the link of a representative at any time', async () => {
    const { parentVisitor, linkId } = await family();

    const response = await world.api.post(`/portal-links/${linkId}/revoke`, world.admin, {});

    expect(response.statusCode).toBe(200);
    expect((await parentVisitor.get('/portal/me')).statusCode).toBe(401);
  });
});
