import type { AuditAction } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  createFakeEmailSender,
  type FakeEmailSender,
} from '../../src/adapters/fake-email/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { membership } from '../../src/db/schema/identity.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';
import { clientFor, signInAs, TEST_PASSWORD } from '../support/session.js';
import { asTenant, createTestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

/**
 * Decision D19, revised and confirmed by the owner of the product on 2026-10-17: the owner AND the
 * admin bring professionals in. An admin who is not an owner leaves a trace (the audit event
 * `professional.added_by_admin`) and every active owner gets an email.
 */
let runtime: DbHandle;
let app: FastifyInstance;
let mail: FakeEmailSender;
let counter = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  mail = createFakeEmailSender();
  app = buildTestApplication(runtime, { email: mail });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

type RoleName = 'owner' | 'admin' | 'professional' | 'reception';

/** A fresh organization with two active owners, one deactivated owner, an admin and a desk. */
async function organization() {
  counter += 1;
  const slug = `prof-added-${String(counter)}`;
  const tenant = await createTestTenant(runtime, { slug });
  const make = (roles: RoleName[], status: 'active' | 'deactivated' = 'active') =>
    createTestUser(runtime, tenant.id, { roles, status, password: TEST_PASSWORD });
  const owners = [await make(['owner']), await make(['owner'])];
  const gone = await make(['owner'], 'deactivated');
  const admin = await make(['admin']);
  const desk = await make(['reception']);
  const api = clientFor(app, slug);
  const audits = (action: AuditAction) =>
    asTenant(runtime, tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
        .orderBy(desc(auditEvent.occurredAt)),
    );
  const rolesOf = async (membershipId: string) => {
    const [row] = await asTenant(runtime, tenant.id, (tx) =>
      tx
        .select({ roles: membership.roles })
        .from(membership)
        .where(eq(membership.id, membershipId)),
    );
    return row?.roles;
  };
  return {
    tenant,
    slug,
    api,
    owners,
    gone,
    admin,
    desk,
    audits,
    rolesOf,
    as: (user: Awaited<ReturnType<typeof make>>) => signInAs(app, slug, user),
    make,
  };
}

describe('an admin grants the professional role to a member', () => {
  it('grants it, audits it, and emails every active owner (and nobody else)', async () => {
    const org = await organization();
    const admin = await org.as(org.admin);
    mail.clear();

    const response = await org.api.put(`/members/${org.desk.membershipId}/roles`, admin, {
      roles: ['reception', 'professional'],
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(await org.rolesOf(org.desk.membershipId)).toEqual(['reception', 'professional']);
    const [event] = await org.audits('professional.added_by_admin');
    expect(event).toMatchObject({
      outcome: 'allow',
      actorUserId: org.admin.id,
      resourceType: 'membership',
      resourceId: org.desk.membershipId,
      metadata: { via: 'role_grant', ownersNotified: 2 },
    });
    for (const owner of org.owners) {
      const message = mail.lastTo(owner.email);
      expect(message?.subject).toContain(org.slug);
      expect(message?.text).toContain('administrador');
      expect(message?.text).toContain('profesional');
      expect(message?.text).toMatch(/https:\/\/.+\/staff/);
    }
    expect(mail.lastTo(org.gone.email)).toBeUndefined();
    expect(mail.lastTo(org.admin.email)).toBeUndefined();
    expect(mail.lastTo(org.desk.email)).toBeUndefined();
    expect(mail.sent).toHaveLength(2);
  });

  it('keeps the ordinary role.changed entry next to the new one', async () => {
    const org = await organization();
    const admin = await org.as(org.admin);

    await org.api.put(`/members/${org.desk.membershipId}/roles`, admin, {
      roles: ['professional'],
    });

    const [change] = await org.audits('role.changed');
    expect(change?.metadata).toMatchObject({
      previousRoles: ['reception'],
      newRoles: ['professional'],
    });
  });

  it('does not email or write the event when an owner grants it', async () => {
    const org = await organization();
    const owner = await org.as(org.owners[0] ?? org.admin);
    mail.clear();

    const response = await org.api.put(`/members/${org.desk.membershipId}/roles`, owner, {
      roles: ['reception', 'professional'],
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(await org.audits('professional.added_by_admin')).toEqual([]);
    expect(mail.sent).toEqual([]);
  });

  it('does not email or write the event for another role, or when the member was already a professional', async () => {
    const org = await organization();
    const admin = await org.as(org.admin);
    const doctor = await org.make(['professional']);
    mail.clear();

    const other = await org.api.put(`/members/${org.desk.membershipId}/roles`, admin, {
      roles: ['reception', 'admin'],
    });
    const keep = await org.api.put(`/members/${doctor.membershipId}/roles`, admin, {
      roles: ['professional', 'reception'],
    });

    expect(other.statusCode).toBe(200);
    expect(keep.statusCode).toBe(200);
    expect(await org.audits('professional.added_by_admin')).toEqual([]);
    expect(mail.sent).toEqual([]);
  });

  it('still refuses the owner role and a change to an owner', async () => {
    const org = await organization();
    const admin = await org.as(org.admin);
    mail.clear();

    const escalate = await org.api.put(`/members/${org.desk.membershipId}/roles`, admin, {
      roles: ['owner'],
    });
    const touchOwner = await org.api.put(
      `/members/${org.owners[0]?.membershipId ?? ''}/roles`,
      admin,
      {
        roles: ['owner', 'professional'],
      },
    );

    expect(escalate.statusCode).toBe(403);
    expect(touchOwner.statusCode).toBe(403);
    expect(await org.audits('professional.added_by_admin')).toEqual([]);
    expect(mail.sent).toEqual([]);
  });

  it('refuses a reception user and writes nothing', async () => {
    const org = await organization();
    const desk = await org.as(org.desk);
    const other = await org.make(['reception']);
    mail.clear();

    const response = await org.api.put(`/members/${other.membershipId}/roles`, desk, {
      roles: ['professional'],
    });

    expect(response.statusCode).toBe(403);
    expect(await org.audits('professional.added_by_admin')).toEqual([]);
    expect(mail.sent).toEqual([]);
  });

  it('keeps the change when the email provider is down: the audit entry is the record', async () => {
    const org = await organization();
    const admin = await org.as(org.admin);
    const down = buildTestApplication(runtime, {
      email: createFakeEmailSender({ failWith: new Error('smtp down') }),
    });
    await down.ready();
    try {
      const response = await clientFor(down, org.slug).put(
        `/members/${org.desk.membershipId}/roles`,
        admin,
        { roles: ['reception', 'professional'] },
      );

      expect(response.statusCode, response.body).toBe(200);
      expect(await org.rolesOf(org.desk.membershipId)).toEqual(['reception', 'professional']);
      expect(await org.audits('professional.added_by_admin')).toHaveLength(1);
    } finally {
      await down.close();
    }
  });
});

describe('an admin invites a professional', () => {
  it('sends the invitation, audits it, and emails every active owner', async () => {
    const org = await organization();
    const admin = await org.as(org.admin);
    const to = `medica-${String(counter)}@clinica.example`;
    mail.clear();

    const response = await org.api.post('/staff/invitations', admin, {
      email: to,
      roles: ['professional'],
      displayName: 'Dra. Ana Perez',
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(mail.lastTo(to)?.text).toContain('accept-invitation?token=');
    const [event] = await org.audits('professional.added_by_admin');
    expect(event).toMatchObject({
      outcome: 'allow',
      actorUserId: org.admin.id,
      resourceType: 'invitation',
      metadata: { via: 'invitation', ownersNotified: 2 },
    });
    expect(JSON.stringify(event)).not.toContain(to);
    for (const owner of org.owners) {
      const message = mail.lastTo(owner.email);
      expect(message?.subject).toContain(org.slug);
      expect(message?.text).toContain('Dra. Ana Perez');
      expect(message?.text).not.toContain('accept-invitation');
    }
    expect(mail.lastTo(org.gone.email)).toBeUndefined();
    expect(mail.sent).toHaveLength(3);
  });

  it('lets the invitee accept: an admin may hand the professional role out', async () => {
    const org = await organization();
    const admin = await org.as(org.admin);
    const to = `acepta-${String(counter)}@clinica.example`;
    await org.api.post('/staff/invitations', admin, { email: to, roles: ['professional'] });
    const token = /accept-invitation\?token=([A-Za-z0-9_-]+)/.exec(
      mail.lastTo(to)?.text ?? '',
    )?.[1];

    const accepted = await org.api.post('/auth/invitations/accept', null, {
      token,
      password: 'una frase propia y larga para entrar',
    });

    expect(accepted.statusCode, accepted.body).toBe(204);
  });

  it('does not notify anyone when an owner invites a professional', async () => {
    const org = await organization();
    const owner = await org.as(org.owners[0] ?? org.admin);
    const to = `por-titular-${String(counter)}@clinica.example`;
    mail.clear();

    const response = await org.api.post('/staff/invitations', owner, {
      email: to,
      roles: ['professional'],
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(await org.audits('professional.added_by_admin')).toEqual([]);
    expect(mail.sent).toHaveLength(1);
  });

  it('does not notify anyone when an admin invites reception or another admin', async () => {
    const org = await organization();
    const admin = await org.as(org.admin);
    const to = `recepcion-${String(counter)}@clinica.example`;
    mail.clear();

    const response = await org.api.post('/staff/invitations', admin, {
      email: to,
      roles: ['reception', 'admin'],
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(await org.audits('professional.added_by_admin')).toEqual([]);
    expect(mail.sent).toHaveLength(1);
  });

  it('still refuses an admin who invites an owner, and writes nothing about professionals', async () => {
    const org = await organization();
    const admin = await org.as(org.admin);
    mail.clear();

    const response = await org.api.post('/staff/invitations', admin, {
      email: `jefe-${String(counter)}@clinica.example`,
      roles: ['owner', 'professional'],
    });

    expect(response.statusCode).toBe(403);
    expect(await org.audits('professional.added_by_admin')).toEqual([]);
    expect(mail.sent).toEqual([]);
  });
});
