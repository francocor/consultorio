import { randomUUID } from 'node:crypto';

import type {
  PortalAcceptedResponse,
  PortalIdentityDto,
  PortalMeResponse,
  Problem,
} from '@consultorio/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { exportPortal } from '../../src/modules/portal/application/export-contributor.js';
import { createMajorityReviewJob } from '../../src/modules/portal/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import { settled } from '../support/export-sections.js';
import { createPortalWorld, type PortalWorld } from '../support/portal-world.js';

/**
 * JD-S5 R1, the staff side of the portal and the age of majority:
 *
 * - A-C1: staff can give no one the record of an ADULT (no representative for an adult, no email
 *   change by reception, no restoring a link after majority), and the people a change concerns are
 *   told;
 * - S5-6: a minor has no account of their own;
 * - S5-7: the age of majority is enforced where the data is read, not by a daily job;
 * - B-T7: the rules of the portal tables are also in the database;
 * - B-T9: an invitation is followed only while what it was sent for is still true;
 * - S5-9, A-T3: the sign-in codes cannot be used to lock a patient out or to find out who has one;
 * - B-W8: the portal part of the cancellation export.
 */
const SLUG = 'portal-staff-hardening';
let runtime: DbHandle;
let world: PortalWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createPortalWorld(runtime, { slug: SLUG, ports: {} });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const NOTE = 'Presentó su DNI y la partida de nacimiento.';
const address = (prefix: string) => `${prefix}-${randomUUID().slice(0, 6)}@example.test`;

const problemOf = (response: LightMyRequestResponse) => response.json<Problem>();

const auditsOf = (action: string) =>
  world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, action as never))),
  );

/** The review of the organization on a given day. */
async function reviewOn(day: string) {
  const job = createMajorityReviewJob({ clock: () => new Date(`${day}T12:00:00.000Z`) });
  return runJob(runtime.db, job, {
    id: randomUUID(),
    name: job.name,
    data: { tenantId: world.tenant.id },
    enqueuedAt: new Date(),
    retryCount: 0,
  });
}

/** A representative with an active account for a child (born in 2020, a minor for years). */
async function parentOf(childEmail: string | null = null) {
  const parentEmail = address('padre');
  const child = await world.patientWith({ birthDate: '2020-09-14', email: childEmail });
  await world.inviteOk(child, { email: parentEmail, relation: 'mother', verificationNote: NOTE });
  await world.activate(world.activationPathSentTo(parentEmail));
  const identity = (await world.portalOf(child)).identities.find(
    (candidate) => candidate.email === parentEmail,
  ) as PortalIdentityDto;
  return { parentEmail, child, identity, linkId: identity.links[0]?.id ?? '' };
}

describe('A-C1: staff cannot give anybody the record of an adult', () => {
  it.each(['reception', 'admin', 'owner'] as const)(
    'refuses a representative for an adult patient to %s, and creates nothing',
    async (role) => {
      const adult = await world.patientWith({ birthDate: '1985-03-10' });
      const insider = address('insider');

      const response = await world.invite(
        adult,
        { email: insider, relation: 'other', verificationNote: NOTE },
        world[role],
      );

      expect(response.statusCode, response.body).toBe(409);
      expect(problemOf(response).code).toBe('portal_representation_requires_minor');
      expect(world.email.lastTo(insider)).toBeUndefined();
      expect((await world.portalOf(adult)).identities).toEqual([]);
    },
  );

  it('refuses to link an adult to an existing account as a dependent', async () => {
    const { identity } = await parentOf();
    const adult = await world.patientWith({ birthDate: '1985-03-10' });

    const response = await world.api.post(
      `/portal-identities/${identity.id}/links`,
      world.reception,
      {
        patientId: adult,
        relation: 'other',
        verificationNote: NOTE,
      },
    );

    expect(response.statusCode, response.body).toBe(409);
    expect(problemOf(response).code).toBe('portal_representation_requires_minor');
  });

  it('still lets the organization invite the representative of a minor, and tells the address on the record', async () => {
    const recordEmail = address('ficha');
    const parentEmail = address('madre');
    const child = await world.patientWith({ birthDate: '2021-02-01', email: recordEmail });

    const response = await world.invite(
      child,
      { email: parentEmail, relation: 'mother', verificationNote: NOTE },
      world.reception,
    );

    expect(response.statusCode, response.body).toBe(201);
    // The notice is queued with the change and a worker sends it (JD-S5 R2-2).
    await world.runJobs();
    const notice = world.email.lastTo(recordEmail);
    expect(notice).toBeDefined();
    expect(notice?.subject).toContain('representante');
    // A warning, never a way in: no link, no code, no name.
    expect(notice?.text).not.toMatch(/https?:/);
    expect(notice?.text).not.toContain(parentEmail);
    const sent = (await auditsOf('portal.notice.sent')).filter(
      (entry) => entry.patientId === child,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.metadata).toMatchObject({ kind: 'representative_added' });
    expect(JSON.stringify(sent[0]?.metadata)).not.toContain(recordEmail);
  });

  it('tells the address on the record when another dependent is linked to an account', async () => {
    const { identity } = await parentOf();
    const recordEmail = address('hermano');
    const sibling = await world.patientWith({ birthDate: '2022-01-02', email: recordEmail });

    const response = await world.api.post(
      `/portal-identities/${identity.id}/links`,
      world.reception,
      {
        patientId: sibling,
        relation: 'mother',
        verificationNote: NOTE,
      },
    );

    expect(response.statusCode, response.body).toBe(201);
    await world.runJobs();
    expect(world.email.lastTo(recordEmail)?.subject).toContain('representante');
  });

  it('keeps changing the email of an account from reception: 403, and nothing changes', async () => {
    const { identity, parentEmail, child } = await parentOf();

    const denied = await world.api.post(
      `/portal-identities/${identity.id}/email`,
      world.reception,
      {
        email: address('mia'),
        verificationNote: 'Verificó su identidad por teléfono con su fecha de nacimiento.',
      },
    );

    expect(denied.statusCode).toBe(403);
    expect((await world.portalOf(child)).identities[0]?.email).toBe(parentEmail);
  });

  it.each(['owner', 'admin'] as const)(
    'lets the %s change it, and tells the OLD address without a link',
    async (role) => {
      const { identity, parentEmail, child } = await parentOf();
      const moved = address('nuevo');

      const response = await world.api.post(
        `/portal-identities/${identity.id}/email`,
        world[role],
        {
          email: moved,
          verificationNote: 'Verificó su identidad por teléfono con su fecha de nacimiento.',
        },
      );

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<{ identity: PortalIdentityDto }>().identity.email).toBe(moved);
      await world.runJobs();
      const notice = world.email.lastTo(parentEmail);
      expect(notice?.subject).toContain('correo');
      expect(notice?.text).not.toMatch(/https?:/);
      expect(notice?.text).not.toContain(moved);
      const sent = (await auditsOf('portal.notice.sent')).filter(
        (entry) => entry.resourceId === identity.id,
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]?.metadata).toMatchObject({ kind: 'email_changed' });
      expect((await world.portalOf(child)).identities[0]?.email).toBe(moved);
    },
  );

  it('does not restore a link after majority: the organization is refused', async () => {
    const { child, linkId } = await parentOf();
    // The birth date of the child is corrected (they are an adult), and the daily review runs.
    const corrected = await world.api.patch(`/patients/${child}`, world.reception, {
      birthDate: '1990-01-01',
    });
    expect(corrected.statusCode, corrected.body).toBe(200);
    expect(await reviewOn('2031-05-05')).toEqual({ status: 'completed' });

    const refused = await world.api.post(`/portal-links/${linkId}/authorize`, world.reception, {
      verificationNote: 'Verificado otra vez en el mostrador.',
    });

    expect(refused.statusCode, refused.body).toBe(409);
    expect(problemOf(refused).code).toBe('portal_representation_requires_minor');
    const row = await world.inTenant((tx) =>
      tx.execute<{ status: string }>(sql`select status from portal_link where id = ${linkId}`),
    );
    expect(row.rows[0]?.status).toBe('suspended');
  });
});

describe('S5-6: a minor has no account of their own', () => {
  it('refuses to invite a minor as themselves', async () => {
    const minor = await world.patientWith({ birthDate: '2015-06-01', email: address('menor') });

    const response = await world.invite(minor);

    expect(response.statusCode, response.body).toBe(409);
    expect(problemOf(response).code).toBe('portal_minor_requires_representative');
    expect((await world.portalOf(minor)).identities).toEqual([]);
  });

  it('does not let the guardian register as the minor with their document and the address of the record', async () => {
    const guardianEmail = address('tutor');
    const nationalId = String(30_000_000 + Math.floor(Math.random() * 9_000_000));
    await world.patientWith({
      birthDate: '2015-06-01',
      email: guardianEmail,
      nationalIdType: 'dni',
      nationalId,
    });
    const visitor = world.visitor();

    const asked = await visitor.post(`/public/${SLUG}/portal/register`, {
      nationalId,
      email: guardianEmail,
      challengeProof: await visitor.solve(),
    });

    // The answer is the one everybody gets, and no code is sent.
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json<PortalAcceptedResponse>()).toEqual({ accepted: true });
    await world.runJobs();
    expect(world.email.lastTo(guardianEmail)).toBeUndefined();
  });
});

describe('S5-7: the age of majority is enforced where the data is read', () => {
  it('refuses a link whose day has come although the daily review has not run', async () => {
    const { parentEmail, child } = await parentOf();
    const visitor = await world.signInAs(parentEmail);
    expect((await visitor.get('/portal/appointments')).statusCode).toBe(200);
    // The day of majority is today; the job did not run (the link is still `active`).
    await world.inTenant((tx) =>
      tx.execute(
        sql`update portal_link set majority_review_on = '2031-05-05' where patient_id = ${child}`,
      ),
    );

    const blocked = await visitor.get('/portal/appointments');
    const me = (await visitor.get('/portal/me')).json<PortalMeResponse>();

    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(problemOf(blocked).code).toBe('portal_subject_required');
    // A link that gives access to nothing does not tell who the person is either.
    expect(me.links[0]).toMatchObject({ status: 'suspended', patientName: '' });
    expect(me.selectedLinkId).toBeNull();
    const stored = await world.inTenant((tx) =>
      tx.execute<{ status: string }>(
        sql`select status from portal_link where patient_id = ${child}`,
      ),
    );
    expect(stored.rows[0]?.status).toBe('active');
  });

  it('refuses the shared documents too, in the function of the database, from the day on', async () => {
    const { child, identity, linkId } = await parentOf();
    const document = await world.documentFor(child);
    const shared = await world.api.post(
      `/documents/${document.id}/portal-share`,
      world.reception,
      {},
    );
    expect(shared.statusCode, shared.body).toBe(200);
    const listed = (today: string) =>
      world.inTenant(async (tx) => {
        await tx.execute(sql`select set_config('app.portal_link_id', ${linkId}, true),
                                    set_config('app.portal_identity_id', ${identity.id}, true),
                                    set_config('app.portal_today', ${today}, true)`);
        return tx.execute(sql`select id from app.portal_shared_documents()`);
      });
    await world.inTenant((tx) =>
      tx.execute(
        sql`update portal_link set majority_review_on = '2031-05-06' where patient_id = ${child}`,
      ),
    );

    expect((await listed('2031-05-05')).rows).toHaveLength(1);
    expect((await listed('2031-05-06')).rows).toHaveLength(0);
  });

  it('brings the day of majority EARLIER when the birth date of the patient is corrected, and never later (JD-S5 R3 B-W2)', async () => {
    const { child } = await parentOf();
    const reviewDay = async () =>
      (
        await world.inTenant((tx) =>
          tx.execute<{ majority_review_on: string }>(
            sql`select majority_review_on::text as majority_review_on from portal_link where patient_id = ${child}`,
          ),
        )
      ).rows[0]?.majority_review_on;
    expect(await reviewDay()).toBe('2038-09-14');

    // Corrected to a LATER date: the access of the representative is not extended (the trigger is
    // what holds it, whoever writes).
    await world.inTenant((tx) =>
      tx.execute(sql`update patient set birth_date = '2022-03-01' where id = ${child}`),
    );
    expect(await reviewDay()).toBe('2038-09-14');
    // Corrected to an EARLIER date. 29 February: the birthday is 1 March in a year that has no 29th.
    await world.inTenant((tx) =>
      tx.execute(sql`update patient set birth_date = '2020-02-29' where id = ${child}`),
    );
    expect(await reviewDay()).toBe('2038-03-01');

    // Corrected to an adult through the screen: the day is in the past and the representative reads
    // nothing at once.
    const adult = await world.api.patch(`/patients/${child}`, world.reception, {
      birthDate: '1990-01-01',
    });
    expect(adult.statusCode, adult.body).toBe(200);
    expect(await reviewDay()).toBe('2008-01-01');
  });
});

describe('B-T7: the rules of the portal tables are in the database too', () => {
  const run = (statement: ReturnType<typeof sql>) => world.inTenant((tx) => tx.execute(statement));

  it('keeps the identity, the patient and the relationship of a link, and a revoked link revoked', async () => {
    const { linkId } = await parentOf();
    const other = await world.patientWith({ birthDate: '2021-01-01' });

    await expect(
      run(sql`update portal_link set patient_id = ${other} where id = ${linkId}`),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
    await expect(
      run(sql`update portal_link set relationship = 'self', relation = null where id = ${linkId}`),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
    const revoked = await world.api.post(`/portal-links/${linkId}/revoke`, world.admin, {});
    expect(revoked.statusCode, revoked.body).toBe(200);
    await expect(
      run(sql`update portal_link set status = 'active', revoked_at = null where id = ${linkId}`),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
  });

  it('keeps the identity and the token of a session, an ended session ended, and its links its own', async () => {
    const mine = await world.patientSession();
    const theirs = await world.patientSession();
    const myLink = mine.identity.links[0]?.id ?? '';
    const theirLink = theirs.identity.links[0]?.id ?? '';
    const session = await world.inTenant((tx) =>
      tx.execute<{ id: string }>(
        sql`select id from portal_session where portal_identity_id = ${mine.identity.id} limit 1`,
      ),
    );
    const id = session.rows[0]?.id ?? '';

    await expect(
      run(
        sql`update portal_session set portal_identity_id = ${theirs.identity.id} where id = ${id}`,
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
    await expect(
      run(sql`update portal_session set token_hash = 'x' where id = ${id}`),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
    await expect(
      run(sql`update portal_session set selected_link_id = ${theirLink} where id = ${id}`),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
    await run(sql`update portal_session set selected_link_id = ${myLink} where id = ${id}`);
    await run(sql`update portal_session set revoked_at = now() where id = ${id}`);
    await expect(
      run(sql`update portal_session set revoked_at = null where id = ${id}`),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
  });

  it('keeps the document and the patient of a share, and an ended share ended', async () => {
    const { child } = await parentOf();
    const other = await world.patientWith({ birthDate: '2021-01-01' });
    const document = await world.documentFor(child);
    const second = await world.documentFor(child);
    const shared = await world.api.post(
      `/documents/${document.id}/portal-share`,
      world.reception,
      {},
    );
    expect(shared.statusCode, shared.body).toBe(200);
    const share = await world.inTenant((tx) =>
      tx.execute<{ id: string }>(
        sql`select id from document_share where document_id = ${document.id}`,
      ),
    );
    const id = share.rows[0]?.id ?? '';

    await expect(
      run(sql`update document_share set patient_id = ${other} where id = ${id}`),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
    await expect(
      run(sql`update document_share set document_id = ${second.id} where id = ${id}`),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
    const ended = await world.api.delete(`/documents/${document.id}/portal-share`, world.reception);
    expect(ended.statusCode, ended.body).toBe(200);
    await expect(
      run(sql`update document_share set unshared_at = null, unshared_by = null where id = ${id}`),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
  });
});

describe('B-T9: an invitation is followed only while it is still true', () => {
  it('does not activate the account of a patient whose address on the record changed', async () => {
    const patient = await world.patientWith({ birthDate: '1985-03-10', email: address('antes') });
    const invited = await world.inviteOk(patient);
    const path = world.activationPathSentTo(invited.email);
    const changed = await world.api.patch(`/patients/${patient}`, world.reception, {
      email: address('despues'),
    });
    expect(changed.statusCode, changed.body).toBe(200);

    const { done } = await world.activate(path);

    expect(done.statusCode).not.toBe(200);
    const shown = await world.portalOf(patient);
    expect(shown.identities.flatMap((identity) => identity.links)).toEqual([]);
    expect(shown.identities.every((identity) => identity.status === 'invited')).toBe(true);
  });
});

describe('S5-9: knowing an address is not enough to lock its owner out', () => {
  it('locks the client that keeps guessing, not the patient who has the code', async () => {
    const { email } = await world.patientSession();
    const attacker = world.visitor({ ip: '10.99.1.1' });
    const answers: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await attacker.post(`/public/${SLUG}/portal/otp/verify`, {
        email,
        code: '000000',
      });
      answers.push(response.statusCode);
    }
    expect(answers).toContain(429);

    // The patient, from another place, asks for a code and signs in.
    const patient = world.visitor({ ip: '10.99.2.2' });
    const asked = await patient.post(`/public/${SLUG}/portal/otp`, {
      email,
      challengeProof: await patient.solve(),
    });
    expect(asked.statusCode, asked.body).toBe(200);
    await world.runJobs();
    const signedIn = await patient.post(`/public/${SLUG}/portal/otp/verify`, {
      email,
      code: world.codeSentTo(email),
    });

    expect(signedIn.statusCode, signedIn.body).toBe(200);
  });
});

describe('A-T3: asking for a code costs the same whether or not the address has an account', () => {
  it('queues the same work for a known and for an unknown address, and sends a code to the known one only', async () => {
    const { email } = await world.patientSession();
    const unknown = address('nadie');
    const queued = () => world.jobs.jobs.filter((job) => job.name === 'portal.code_send').length;
    const visitor = world.visitor();

    const before = queued();
    const known = await visitor.post(`/public/${SLUG}/portal/otp`, {
      email,
      challengeProof: await visitor.solve(),
    });
    const afterKnown = queued();
    const stranger = await visitor.post(`/public/${SLUG}/portal/otp`, {
      email: unknown,
      challengeProof: await visitor.solve(),
    });
    const afterUnknown = queued();
    await world.runJobs();

    expect(known.body.replace(/"requestId":"[^"]+"/, '')).toBe(
      stranger.body.replace(/"requestId":"[^"]+"/, ''),
    );
    expect(afterKnown - before).toBe(1);
    expect(afterUnknown - afterKnown).toBe(1);
    expect(world.email.lastTo(email)).toBeDefined();
    expect(world.email.lastTo(unknown)).toBeUndefined();
    // The decoy ends no live code of anybody: asking again for an unknown address leaves the real one usable.
    const code = world.codeSentTo(email);
    await visitor.post(`/public/${SLUG}/portal/otp`, {
      email: unknown,
      challengeProof: await visitor.solve(),
    });
    const signedIn = await visitor.post(`/public/${SLUG}/portal/otp/verify`, { email, code });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
  });
});

describe('B-S5: the adult ends the access of a representative also in a read-only organization', () => {
  it('lets the revocation through, because it protects the person', async () => {
    const parentEmail = address('padre');
    const adultEmail = address('adulto');
    const adultId = await world.patientWith({ birthDate: '1990-01-01', email: adultEmail });
    await world.inviteOk(adultId);
    await world.activate(world.activationPathSentTo(adultEmail));
    // A representative the adult once authorized (made straight in the database).
    const parentLink = await world.inTenant(async (tx) => {
      const identity = await tx.execute<{ id: string }>(
        sql`insert into portal_identity (tenant_id, email, status, activated_at)
              values (${world.tenant.id}, ${parentEmail}, 'active', now()) returning id`,
      );
      const link = await tx.execute<{ id: string }>(
        sql`insert into portal_link (tenant_id, portal_identity_id, patient_id, relationship, relation, verification_note)
              values (${world.tenant.id}, ${identity.rows[0]?.id ?? ''}, ${adultId}, 'representative', 'mother', 'autorizada por la persona')
              returning id`,
      );
      return link.rows[0]?.id ?? '';
    });
    const visitor = await world.signInAs(adultEmail);
    await world.inTenant((tx) =>
      tx.execute(
        sql`update tenant set status = 'read_only', read_only_since = now() where id = ${world.tenant.id}`,
      ),
    );
    try {
      const response = await visitor.post(`/portal/links/${parentLink}/revoke`, {});

      expect(response.statusCode, response.body).toBe(204);
    } finally {
      await world.inTenant((tx) =>
        tx.execute(
          sql`update tenant set status = 'active', read_only_since = null where id = ${world.tenant.id}`,
        ),
      );
    }
  });
});

describe('B-W8: the portal part of the cancellation export', () => {
  it('lists the accounts, what they may read, the shares and the sessions, and never a token or a note', async () => {
    const { parentEmail, child, linkId, identity } = await parentOf();
    await world.signInAs(parentEmail);
    const document = await world.documentFor(child);
    const shared = await world.api.post(
      `/documents/${document.id}/portal-share`,
      world.reception,
      {},
    );
    expect(shared.statusCode, shared.body).toBe(200);

    const exported = (await world.inTenant((tx) =>
      settled(exportPortal({ tx, tenantId: world.tenant.id })),
    )) as {
      identities: { id: string; email: string; status: string }[];
      links: { id: string; patientId: string; relationship: string; relation: string | null }[];
      sessions: { identityId: string; revokedAt: string | null }[];
      documentShares: { documentId: string; patientId: string; unsharedAt: string | null }[];
    };

    expect(exported.identities.find((entry) => entry.id === identity.id)).toMatchObject({
      email: parentEmail,
      status: 'active',
    });
    expect(exported.links.find((entry) => entry.id === linkId)).toMatchObject({
      patientId: child,
      relationship: 'representative',
      relation: 'mother',
    });
    expect(exported.sessions.some((entry) => entry.identityId === identity.id)).toBe(true);
    expect(exported.documentShares).toContainEqual(
      expect.objectContaining({ documentId: document.id, patientId: child, unsharedAt: null }),
    );
    const text = JSON.stringify(exported);
    expect(text).not.toMatch(/token/i);
    expect(text).not.toContain(NOTE);
    expect(text).not.toContain('verification');
    expect(text).not.toContain('"ip"');
    expect(text).not.toContain('userAgent');
  });
});
