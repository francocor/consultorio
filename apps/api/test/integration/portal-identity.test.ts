import type { PatientPortalResponse, PortalIdentityDto, Problem } from '@consultorio/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createPortalWorld, rowsOf, type PortalWorld } from '../support/portal-world.js';
import { createTestTenant } from '../support/tenants.js';

/**
 * Portal identities (S5.06, tasks 5.24 to 5.26): staff invite a patient, the activation link makes
 * the identity and its self link, a parent gets several children under one identity, and staff can
 * end an account, a link or change an email without touching the patient record.
 */
let runtime: DbHandle;
let world: PortalWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createPortalWorld(runtime, { slug: 'portal-identity' });
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

describe('inviting a patient', () => {
  it('emails a single-use activation link to the address on the record, and makes a pending identity', async () => {
    const email = 'invitada@example.test';
    const patientId = await world.patientWith({ email });

    const identity = await world.inviteOk(patientId);

    expect(identity).toMatchObject({ email, status: 'invited', activatedAt: null, links: [] });
    const mail = world.email.lastTo(email);
    expect(mail?.subject).toContain('Active su acceso al portal');
    expect(world.activationPathSentTo(email)).toMatch(/^\/public\/t\/[A-Za-z0-9_-]{43}$/);
    // The patient record shows the pending invitation.
    const shown = await world.portalOf(patientId);
    expect(shown.identities.map((candidate) => candidate.status)).toEqual(['invited']);
  });

  it('is for reception, the administration and the owner, and not for a professional', async () => {
    const patientId = await world.patientWith();

    for (const by of [world.reception, world.admin, world.owner]) {
      const fresh = await world.patientWith();
      expect((await world.invite(fresh, {}, by)).statusCode).toBe(201);
    }
    const denied = await world.invite(patientId, {}, world.doctor);

    expect(denied.statusCode).toBe(403);
    const rows = await world.inTenant((tx) =>
      tx.select().from(auditEvent).where(eq(auditEvent.action, 'access.denied')),
    );
    expect(rows.some((row) => row.reason === 'not_permitted')).toBe(true);
  });

  it('needs an email on the record', async () => {
    const patientId = await world.patientWith({ email: null });
    const before = world.email.sent.length;

    const response = await world.invite(patientId);

    expect(response.statusCode).toBe(409);
    expect(response.json<Problem>().code).toBe('portal_patient_has_no_email');
    expect(world.email.sent).toHaveLength(before);
  });

  it('answers not found for a patient that does not exist', async () => {
    const response = await world.invite('0190a000-0000-7000-8000-00000000dead');

    expect(response.statusCode).toBe(404);
  });

  it('sends the link again to the same patient, and the older link stops working', async () => {
    const email = 'reenvio@example.test';
    const patientId = await world.patientWith({ email });
    await world.inviteOk(patientId);
    const first = world.activationPathSentTo(email);

    await world.inviteOk(patientId);
    const second = world.activationPathSentTo(email);

    expect(second).not.toBe(first);
    expect((await world.activate(first)).done.statusCode).toBe(404);
    expect((await world.activate(second)).done.statusCode).toBe(200);
    expect((await world.portalOf(patientId)).identities).toHaveLength(1);
  });

  it('audits the creation of the identity without the address', async () => {
    const patientId = await world.patientWith();
    const identity = await world.inviteOk(patientId);

    const rows = (await audits('portal.identity.created')).filter(
      (row) => row.resourceId === identity.id,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'allow', patientId, resourceType: 'portal_identity' });
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain('@');
  });
});

describe('following the activation link', () => {
  it('shows what it is for without using it, and creates the identity and its self link when pressed', async () => {
    const email = 'activa@example.test';
    const patientId = await world.patientWith({ email });
    await world.inviteOk(patientId);
    const path = world.activationPathSentTo(email);

    const { page, done } = await world.activate(path);

    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Activar mi acceso');
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('portal');
    const shown = await world.portalOf(patientId);
    expect(shown.identities).toHaveLength(1);
    expect(shown.identities[0]).toMatchObject({ email, status: 'active' });
    expect(shown.identities[0]?.links).toEqual([
      expect.objectContaining({
        patientId,
        relationship: 'self',
        relation: null,
        status: 'active',
        majorityReviewOn: null,
      }),
    ]);
    const linked = (await audits('portal.identity.linked')).filter(
      (row) => row.patientId === patientId,
    );
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ actingRole: 'patient', actorUserId: null });
  });

  it('works once: a second press, and a link that was only opened, find nothing to do', async () => {
    const email = 'una-vez@example.test';
    const patientId = await world.patientWith({ email });
    await world.inviteOk(patientId);
    const path = world.activationPathSentTo(email);
    const looker = world.visitor();
    expect((await looker.get(path)).statusCode).toBe(200);
    expect((await world.portalOf(patientId)).identities[0]?.status).toBe('invited');

    expect((await looker.post(path, {})).statusCode).toBe(200);
    const again = await looker.post(path, {});

    expect(again.statusCode).toBe(404);
    expect((await world.portalOf(patientId)).identities[0]?.links).toHaveLength(1);
  });

  it('refuses a link that expired, offers nothing, and a new invitation works', async () => {
    const email = 'vencida@example.test';
    const patientId = await world.patientWith({ email });
    const invited = await world.inviteOk(patientId);
    const path = world.activationPathSentTo(email);
    // The week of the link is over (the clock of the application is not moved: the staff
    // sessions of the other tests run on it).
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE action_token
              SET expires_at = ${world.now().toISOString()}::timestamptz - interval '1 minute'
            WHERE kind = 'portal_activation' AND subject_id = ${invited.id}`,
      ),
    );

    const { page, done } = await world.activate(path);

    expect(page.statusCode).toBe(404);
    expect(done.statusCode).toBe(404);
    expect((await world.portalOf(patientId)).identities[0]?.status).toBe('invited');

    await world.inviteOk(patientId);
    expect((await world.activate(world.activationPathSentTo(email))).done.statusCode).toBe(200);
    expect((await world.portalOf(patientId)).identities[0]?.status).toBe('active');
  });

  it('refuses a token of another kind and a guess', async () => {
    const visitor = world.visitor();

    expect((await visitor.get('/public/t/not-a-token')).statusCode).toBe(404);
    expect((await visitor.post(`/public/t/${'a'.repeat(43)}`, {})).statusCode).toBe(404);
  });
});

describe('one email, one adult', () => {
  it('refuses to invite a second patient at an address that already has an account', async () => {
    const email = 'compartida@example.test';
    const first = await world.patientWith({ email });
    await world.onboard(first);
    const second = await world.patientWith({ email });

    const response = await world.invite(second);

    expect(response.statusCode).toBe(409);
    expect(response.json<Problem>().code).toBe('portal_email_in_use');
    expect((await world.portalOf(second)).identities).toEqual([]);
  });

  it('refuses a second invitation at an address that is waiting for another patient', async () => {
    const email = 'pendiente@example.test';
    const first = await world.patientWith({ email });
    await world.inviteOk(first);
    const second = await world.patientWith({ email });

    const response = await world.invite(second);

    expect(response.statusCode).toBe(409);
    expect(response.json<Problem>().code).toBe('portal_email_in_use');
  });

  it('says a patient who already has an account of their own is linked', async () => {
    const patientId = await world.patientWith();
    await world.onboard(patientId);

    const response = await world.invite(patientId);

    expect(response.statusCode).toBe(409);
    expect(response.json<Problem>().code).toBe('portal_already_linked');
  });
});

describe('a parent with two children', () => {
  it('has one identity that reaches both dependents, each with the relation and the day of majority', async () => {
    const parentEmail = 'madre@example.test';
    const child1 = await world.patientWith({ birthDate: '2020-09-14', email: null });
    const child2 = await world.patientWith({ birthDate: '2022-01-02', email: null });
    const note = 'Presentó su DNI y la partida de nacimiento en el mostrador.';

    const invited = await world.inviteOk(child1, {
      email: parentEmail,
      relation: 'mother',
      verificationNote: note,
    });
    expect(invited).toMatchObject({ email: parentEmail, status: 'invited' });
    expect((await world.activate(world.activationPathSentTo(parentEmail))).done.statusCode).toBe(
      200,
    );
    const linked = await world.api.post(`/portal-identities/${invited.id}/links`, world.reception, {
      patientId: child2,
      relation: 'mother',
      verificationNote: note,
    });

    expect(linked.statusCode, linked.body).toBe(201);
    const identity = linked.json<{ identity: PortalIdentityDto }>().identity;
    expect(
      identity.links.map((link) => [link.patientId, link.relationship, link.relation]),
    ).toEqual([
      [child1, 'representative', 'mother'],
      [child2, 'representative', 'mother'],
    ]);
    expect(identity.links.map((link) => link.majorityReviewOn)).toEqual([
      '2038-09-14',
      '2040-01-02',
    ]);
    expect(identity.links.every((link) => link.status === 'active')).toBe(true);
    // The children are not "self" for anybody, so the parent can still be a patient apart.
    const parent = await world.patientWith({ email: 'otra-madre@example.test' });
    expect((await world.invite(parent)).statusCode).toBe(201);
  });

  it('needs the verification note and refuses the same dependent twice', async () => {
    const email = 'padre@example.test';
    const child = await world.patientWith({ birthDate: '2021-06-01', email: null });
    const sibling = await world.patientWith({ birthDate: '2023-06-01', email: null });
    const invited = await world.inviteOk(child, {
      email,
      relation: 'father',
      verificationNote: 'Verificado en persona con la partida de nacimiento.',
    });
    await world.activate(world.activationPathSentTo(email));

    const noNote = await world.api.post(`/portal-identities/${invited.id}/links`, world.reception, {
      patientId: sibling,
      relation: 'father',
    });
    const twice = await world.api.post(`/portal-identities/${invited.id}/links`, world.reception, {
      patientId: child,
      relation: 'father',
      verificationNote: 'Verificado en persona con la partida de nacimiento.',
    });

    expect(noNote.statusCode).toBe(400);
    expect(twice.statusCode).toBe(409);
    expect(twice.json<Problem>().code).toBe('portal_already_linked');
  });

  it('refuses to invite a representative at the address of an account that exists: link the dependent instead', async () => {
    const email = 'ya-existe@example.test';
    await world.onboard(await world.patientWith({ email }));
    const child = await world.patientWith({ birthDate: '2021-06-01', email: null });

    const response = await world.invite(child, {
      email,
      relation: 'mother',
      verificationNote: 'Verificado en persona con la partida de nacimiento.',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<Problem>().code).toBe('portal_email_in_use');
  });
});

describe('what the database guarantees', () => {
  async function identityId(): Promise<string> {
    const [row] = await rowsOf<{ id: string }>(
      world,
      sql`INSERT INTO portal_identity (tenant_id, email, status, activated_at)
            VALUES (${world.tenant.id}, ${`db-${crypto.randomUUID()}@example.test`}, 'active', now())
            RETURNING id`,
    );
    if (!row) throw new Error('no identity');
    return row.id;
  }
  const link = (identity: string, patientId: string, relationship = 'self') =>
    world.inTenant((tx) =>
      tx.execute(
        sql`INSERT INTO portal_link (tenant_id, portal_identity_id, patient_id, relationship, relation, verification_note)
              VALUES (${world.tenant.id}, ${identity}, ${patientId}, ${relationship},
                      ${relationship === 'self' ? null : 'mother'},
                      ${relationship === 'self' ? null : 'nota de verificación'})`,
      ),
    );

  it('rejects a second live self link for one identity and a second for one patient', async () => {
    const identity = await identityId();
    const patientId = await world.patientWith();
    await link(identity, patientId);

    await expect(link(identity, await world.patientWith())).rejects.toMatchObject({
      cause: { code: '23505' },
    });
    await expect(link(await identityId(), patientId)).rejects.toMatchObject({
      cause: { code: '23505' },
    });
  });

  it('frees both when the self link is revoked', async () => {
    const identity = await identityId();
    const patientId = await world.patientWith();
    await link(identity, patientId);
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE portal_link SET status = 'revoked', revoked_at = now() WHERE patient_id = ${patientId}`,
      ),
    );

    await link(await identityId(), patientId);
  });

  it('rejects a link to a patient of another organization', async () => {
    const other = await createTestTenant(runtime, { slug: 'portal-identity-other' });
    const foreign = await createPortalPatientOf(other.id);

    await expect(link(await identityId(), foreign)).rejects.toMatchObject({
      cause: { code: '23503' },
    });
  });

  it('rejects a representative link without a relation or without the note, and a self link with a relation', async () => {
    const identity = await identityId();
    const run = (relationship: string, relation: string | null, note: string | null) =>
      world.inTenant(async (tx) =>
        tx.execute(
          sql`INSERT INTO portal_link (tenant_id, portal_identity_id, patient_id, relationship, relation, verification_note)
                VALUES (${world.tenant.id}, ${identity}, ${await world.patientWith()}, ${relationship}, ${relation}, ${note})`,
        ),
      );

    await expect(run('representative', null, 'nota')).rejects.toMatchObject({
      cause: { code: '23514' },
    });
    await expect(run('representative', 'mother', null)).rejects.toMatchObject({
      cause: { code: '23514' },
    });
    await expect(run('self', 'mother', null)).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('keeps one identity per email in an organization, whatever the case', async () => {
    const email = `Mismo-${crypto.randomUUID().slice(0, 6)}@example.test`;
    await world.inTenant((tx) =>
      tx.execute(
        sql`INSERT INTO portal_identity (tenant_id, email) VALUES (${world.tenant.id}, ${email})`,
      ),
    );

    await expect(
      world.inTenant((tx) =>
        tx.execute(
          sql`INSERT INTO portal_identity (tenant_id, email) VALUES (${world.tenant.id}, ${email.toUpperCase()})`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('does not let the application role delete accounts, links or sessions', async () => {
    for (const table of ['portal_identity', 'portal_link', 'portal_session']) {
      await expect(
        world.inTenant((tx) => tx.execute(sql.raw(`DELETE FROM ${table}`))),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    }
  });
});

async function createPortalPatientOf(tenantId: string): Promise<string> {
  const { createTestPatient } = await import('../support/patients.js');
  return createTestPatient(runtime, tenantId);
}

describe('ending access', () => {
  async function activeWithSession(email: string) {
    const patientId = await world.patientWith({ email });
    const identity = await world.onboard(patientId);
    const [session] = await rowsOf<{ id: string }>(
      world,
      sql`INSERT INTO portal_session (tenant_id, portal_identity_id, token_hash, expires_at)
            VALUES (${world.tenant.id}, ${identity.id}, ${crypto.randomUUID()}, now() + interval '12 hours')
            RETURNING id`,
    );
    return { patientId, identity, sessionId: session?.id ?? '' };
  }
  const sessionRevoked = async (sessionId: string) => {
    const [row] = await rowsOf<{ revoked_at: Date | null; revoked_reason: string | null }>(
      world,
      sql`SELECT revoked_at, revoked_reason FROM portal_session WHERE id = ${sessionId}`,
    );
    return row;
  };

  it('deactivates an identity without touching the patient, and ends its sessions', async () => {
    const { patientId, identity, sessionId } = await activeWithSession('baja@example.test');

    const response = await world.api.post(
      `/portal-identities/${identity.id}/deactivate`,
      world.admin,
      {},
    );

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ identity: PortalIdentityDto }>().identity.status).toBe('deactivated');
    expect(await sessionRevoked(sessionId)).toMatchObject({ revoked_reason: 'deactivated' });
    const [patientRow] = await rowsOf<{ status: string }>(
      world,
      sql`SELECT status FROM patient WHERE id = ${patientId}`,
    );
    expect(patientRow?.status).toBe('active');
    const rows = (await audits('portal.identity.deactivated')).filter(
      (row) => row.resourceId === identity.id,
    );
    expect(rows).toHaveLength(1);
    // Doing it twice is a conflict, not a second audit entry.
    const again = await world.api.post(
      `/portal-identities/${identity.id}/deactivate`,
      world.admin,
      {},
    );
    expect(again.statusCode).toBe(409);
    expect(again.json<Problem>().code).toBe('portal_state_conflict');
  });

  it('revokes one link and leaves the identity and its other links', async () => {
    const email = 'dos-hijos@example.test';
    const child1 = await world.patientWith({ birthDate: '2021-06-01', email: null });
    const child2 = await world.patientWith({ birthDate: '2023-06-01', email: null });
    const note = 'Verificado en persona con la partida de nacimiento.';
    const invited = await world.inviteOk(child1, {
      email,
      relation: 'mother',
      verificationNote: note,
    });
    await world.activate(world.activationPathSentTo(email));
    const both = await world.api.post(`/portal-identities/${invited.id}/links`, world.reception, {
      patientId: child2,
      relation: 'mother',
      verificationNote: note,
    });
    const target = both.json<{ identity: PortalIdentityDto }>().identity.links[0];

    const response = await world.api.post(
      `/portal-links/${target?.id ?? ''}/revoke`,
      world.reception,
      {},
    );

    expect(response.statusCode, response.body).toBe(200);
    const identity = response.json<{ identity: PortalIdentityDto }>().identity;
    expect(identity.status).toBe('active');
    expect(identity.links.map((link) => [link.patientId, link.status])).toEqual([
      [child1, 'revoked'],
      [child2, 'active'],
    ]);
  });

  it('changes the email only after the verification note, ends the sessions and audits it', async () => {
    const { identity, sessionId } = await activeWithSession('antes@example.test');

    // The owner and the admin, not reception (JD-S5 R1-A-C1).
    const response = await world.api.post(`/portal-identities/${identity.id}/email`, world.admin, {
      email: 'despues@example.test',
      verificationNote: 'Verificó su identidad por teléfono con su fecha de nacimiento.',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ identity: PortalIdentityDto }>().identity.email).toBe(
      'despues@example.test',
    );
    expect(await sessionRevoked(sessionId)).toMatchObject({ revoked_reason: 'email_changed' });
    const changed = (await audits('portal.profile.changed')).filter(
      (row) => row.resourceId === identity.id,
    );
    expect(changed).toHaveLength(1);
    expect(JSON.stringify(changed[0]?.metadata)).not.toContain('@');
  });

  it('refuses to change the email to one that has an account, and without the note', async () => {
    const { identity } = await activeWithSession('cambio@example.test');
    await world.onboard(await world.patientWith({ email: 'ocupada@example.test' }));

    const taken = await world.api.post(`/portal-identities/${identity.id}/email`, world.owner, {
      email: 'ocupada@example.test',
      verificationNote: 'Verificó su identidad por teléfono con su fecha de nacimiento.',
    });
    const noNote = await world.api.post(`/portal-identities/${identity.id}/email`, world.owner, {
      email: 'libre@example.test',
    });

    expect(taken.statusCode).toBe(409);
    expect(taken.json<Problem>().code).toBe('portal_email_in_use');
    expect(noNote.statusCode).toBe(400);
  });

  it('is staff work that a professional cannot do', async () => {
    const { identity } = await activeWithSession('profesional@example.test');

    for (const [path, body] of [
      [`/portal-identities/${identity.id}/deactivate`, {}],
      [
        `/portal-identities/${identity.id}/email`,
        { email: 'x@example.test', verificationNote: 'Verificado por teléfono.' },
      ],
    ] as const) {
      expect((await world.api.post(path, world.doctor, body)).statusCode, path).toBe(403);
    }
  });
});

describe('a read-only organization', () => {
  it('blocks the staff writes of the portal accounts and keeps the patient screen readable', async () => {
    const patientId = await world.patientWith();
    const identity = await world.onboard(patientId);
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE tenant SET status = 'read_only', read_only_since = now() WHERE id = ${world.tenant.id}`,
      ),
    );
    try {
      const invite = await world.invite(await world.patientWith());
      const deactivate = await world.api.post(
        `/portal-identities/${identity.id}/deactivate`,
        world.admin,
        {},
      );
      const read = await world.api.get(`/patients/${patientId}/portal`, world.reception);

      expect(invite.statusCode).toBe(402);
      expect(deactivate.statusCode).toBe(402);
      expect(read.statusCode).toBe(200);
      expect(read.json<PatientPortalResponse>().identities).toHaveLength(1);
    } finally {
      await world.inTenant((tx) =>
        tx.execute(
          sql`UPDATE tenant SET status = 'active', read_only_since = NULL WHERE id = ${world.tenant.id}`,
        ),
      );
    }
  });
});
