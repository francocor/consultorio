import {
  MatriculaQueueResponse,
  OperatorMatriculaDto,
  type AuditAction,
  type PlatformAuditAction,
  type ProfessionalDto,
} from '@consultorio/contracts';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { matriculaOperatorNote, platformAuditEvent } from '../../src/db/schema/operator.js';
import { professional } from '../../src/db/schema/staff.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';
import { buildTestApplication } from '../support/app.js';
import { verifyMatriculaAsOperator } from '../support/matricula.js';
import {
  createOperatorHarness,
  createTestClock,
  operatorSession,
  platformHeaders,
  type OperatorHarness,
  type TestClock,
} from '../support/operator.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let harness: OperatorHarness;
let app: FastifyInstance;
let clock: TestClock;
let cookie: string;
let operatorId: string;
let south: TestTenant;
let north: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  harness = createOperatorHarness();
  clock = createTestClock();
  app = buildTestApplication(runtime, {
    operator: { database: harness.db, secrets: harness.secrets },
    clock: clock.read,
  });
  const operator = await harness.addOperator();
  operatorId = operator.id;
  cookie = await operatorSession(app, operator, clock);
  south = await createTestTenant(runtime, {
    slug: 'matricula-south',
    theme: { displayName: 'Consultorio Sur' },
  });
  north = await createTestTenant(runtime, {
    slug: 'matricula-north',
    theme: { displayName: 'Centro Norte' },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await harness.close();
  await runtime.close();
});

const send = (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
  session: string | null = cookie,
) =>
  app.inject({
    method,
    url,
    headers: platformHeaders(session ?? undefined),
    remoteAddress: '10.95.0.2',
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const verifyUrl = (tenant: TestTenant, professionalId: string) =>
  `/operator/tenants/${tenant.id}/professionals/${professionalId}/matricula/verify`;
/** What the operator's screen sends: the registration they reviewed, plus an optional note. */
const verify = (tenant: TestTenant, who: { professionalId: string; number: string }, extra = {}) =>
  send('POST', verifyUrl(tenant, who.professionalId), {
    jurisdiction: 'AR-B',
    number: who.number,
    ...extra,
  });
const reviewed = { jurisdiction: 'AR-B', number: '1' };
const unverifyUrl = (tenant: TestTenant, professionalId: string) =>
  `/operator/tenants/${tenant.id}/professionals/${professionalId}/matricula/unverify`;
const noteUrl = (tenant: TestTenant, professionalId: string) =>
  `/operator/tenants/${tenant.id}/professionals/${professionalId}/matricula/note`;

let numberCounter = 600_000;
const freshNumber = () => String((numberCounter += 1));

interface Registered {
  professionalId: string;
  membershipId: string;
  session: TestSession;
  number: string;
}

/** A professional who records their registration through the real profile endpoint. */
async function registered(
  tenant: TestTenant,
  fullName = 'Lucía Paz',
  number = freshNumber(),
): Promise<Registered> {
  const user = await createTestUser(runtime, tenant.id, {
    roles: ['professional'],
    password: TEST_PASSWORD,
  });
  const session = await signInAs(app, tenant.slug, user);
  const saved = await save({ membershipId: user.membershipId, session }, tenant, number, fullName);
  return {
    professionalId: saved.json<ProfessionalDto>().id,
    membershipId: user.membershipId,
    session,
    number,
  };
}

function save(
  person: { membershipId: string; session: TestSession },
  tenant: TestTenant,
  number: string,
  fullName = 'Lucía Paz',
) {
  return clientFor(app, tenant.slug).put(
    `/staff/${person.membershipId}/professional-profile`,
    person.session,
    {
      fullName,
      specialties: ['Clínica médica'],
      matricula: { jurisdiction: 'AR-B', number },
    },
  );
}

const profileOf = async (tenant: TestTenant, who: Registered) =>
  (
    await clientFor(app, tenant.slug).get(
      `/staff/${who.membershipId}/professional-profile`,
      who.session,
    )
  ).json<ProfessionalDto>();

async function platformEvents(action: PlatformAuditAction, resourceId: string) {
  return harness.db.db
    .select()
    .from(platformAuditEvent)
    .where(
      and(eq(platformAuditEvent.action, action), eq(platformAuditEvent.resourceId, resourceId)),
    )
    .orderBy(asc(platformAuditEvent.occurredAt));
}

async function tenantEvents(tenant: TestTenant, action: AuditAction, resourceId: string) {
  const rows = await asTenant(runtime, tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return rows.filter((row) => row.resourceId === resourceId);
}

const rowOf = async (tenant: TestTenant, professionalId: string) => {
  const [row] = await asTenant(runtime, tenant.id, (tx) =>
    tx.select().from(professional).where(eq(professional.id, professionalId)),
  );
  return row;
};

const queue = async (status?: 'verified') => {
  const response = await send(
    'GET',
    status === undefined
      ? '/operator/matricula-queue'
      : `/operator/matricula-queue?status=${status}`,
  );
  expect(response.statusCode).toBe(200);
  return MatriculaQueueResponse.parse(response.json()).items;
};

describe('the operator verifies a matricula', () => {
  it('marks it verified, names the operator and writes both trails in the same transaction', async () => {
    const who = await registered(south);
    expect((await profileOf(south, who)).matricula?.status).toBe('unverified');

    const response = await verify(south, who);

    expect(response.statusCode).toBe(200);
    expect(OperatorMatriculaDto.parse(response.json())).toMatchObject({
      tenant: { id: south.id, name: 'Consultorio Sur' },
      professionalId: who.professionalId,
      fullName: 'Lucía Paz',
      jurisdiction: 'AR-B',
      number: who.number,
      status: 'verified',
    });
    expect(await rowOf(south, who.professionalId)).toMatchObject({
      matriculaStatus: 'verified',
      verifiedByOperator: operatorId,
    });
    expect((await profileOf(south, who)).matricula?.status).toBe('verified');

    const [platform, ...rest] = await platformEvents(
      'operator.matricula.verified',
      who.professionalId,
    );
    expect(rest).toEqual([]);
    expect(platform).toMatchObject({
      operatorId,
      targetTenantId: south.id,
      outcome: 'allow',
      resourceType: 'professional',
    });
    const [tenantEvent, ...others] = await tenantEvents(
      south,
      'matricula.verified',
      who.professionalId,
    );
    expect(others).toEqual([]);
    expect(tenantEvent).toMatchObject({ actorUserId: operatorId, outcome: 'allow' });
  });

  it('refuses to verify twice and keeps a single entry in the trail', async () => {
    const who = await registered(south);
    await verify(south, who);

    const again = await verify(south, who);

    expect(again.statusCode).toBe(409);
    expect(await platformEvents('operator.matricula.verified', who.professionalId)).toHaveLength(1);
  });

  it('refuses a profile with no registration recorded and an inactive one', async () => {
    const blank = await createTestUser(runtime, south.id, { roles: ['professional'] });
    const blankId = uuidv7();
    await asTenant(runtime, south.id, (tx) =>
      tx
        .insert(professional)
        .values({ id: blankId, tenantId: south.id, membershipId: blank.membershipId }),
    );
    const inactive = await registered(south);
    await asTenant(runtime, south.id, (tx) =>
      tx
        .update(professional)
        .set({ status: 'inactive' })
        .where(eq(professional.id, inactive.professionalId)),
    );

    expect((await send('POST', verifyUrl(south, blankId), reviewed)).statusCode).toBe(409);
    expect((await verify(south, inactive)).statusCode).toBe(409);
    expect((await rowOf(south, blankId))?.matriculaStatus).toBe('unverified');
    expect((await rowOf(south, inactive.professionalId))?.matriculaStatus).toBe('unverified');
  });

  it('does not find a professional of another organization, nor one that does not exist', async () => {
    const elsewhere = await registered(north);

    const crossed = await verify(south, elsewhere);
    const unknown = await send('POST', verifyUrl(south, uuidv7()), reviewed);
    const malformed = await send(
      'POST',
      `/operator/tenants/${south.id}/professionals/nope/matricula/verify`,
      reviewed,
    );

    expect(crossed.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(400);
    expect((await rowOf(north, elsewhere.professionalId))?.matriculaStatus).toBe('unverified');
  });

  it('refuses when the organization edited the registration after the operator looked at it', async () => {
    const who = await registered(south);
    const seen = who.number;
    const edited = freshNumber();
    await save(who, south, edited);

    const stale = await verify(south, { professionalId: who.professionalId, number: seen });
    const wrongJurisdiction = await verify(
      south,
      { professionalId: who.professionalId, number: edited },
      {
        jurisdiction: 'AR-C',
      },
    );

    expect(stale.statusCode).toBe(409);
    expect(wrongJurisdiction.statusCode).toBe(409);
    expect((await rowOf(south, who.professionalId))?.matriculaStatus).toBe('unverified');
    expect(await platformEvents('operator.matricula.verified', who.professionalId)).toEqual([]);

    const current = await verify(south, { professionalId: who.professionalId, number: edited });
    expect(current.statusCode).toBe(200);
  });

  it('saves the note that comes with the decision', async () => {
    const who = await registered(south);

    const response = await verify(south, who, { note: '  Consultada en el colegio, vigente.  ' });

    expect(response.json<{ note: string }>().note).toBe('Consultada en el colegio, vigente.');
    const listed = await queue('verified');
    expect(listed.find((item) => item.professionalId === who.professionalId)?.note).toBe(
      'Consultada en el colegio, vigente.',
    );
  });
});

describe('only the operator can', () => {
  it('answers nobody without an operator session', async () => {
    const who = await registered(south);

    const response = await send('POST', verifyUrl(south, who.professionalId), reviewed, null);
    const queueResponse = await send('GET', '/operator/matricula-queue', undefined, null);

    expect(response.statusCode).toBe(401);
    expect(queueResponse.statusCode).toBe(401);
    expect((await rowOf(south, who.professionalId))?.matriculaStatus).toBe('unverified');
  });

  it('is not reachable from a tenant host, even for the professional themselves or an owner', async () => {
    const who = await registered(south);
    const owner = await signInAs(
      app,
      south.slug,
      await createTestUser(runtime, south.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );
    const api = clientFor(app, south.slug);

    for (const session of [who.session, owner]) {
      const attempt = await api.post(verifyUrl(south, who.professionalId), session, reviewed);
      const list = await api.get('/operator/matricula-queue', session);
      expect(attempt.statusCode).toBe(404);
      expect(list.statusCode).toBe(404);
    }
    expect((await rowOf(south, who.professionalId))?.matriculaStatus).toBe('unverified');
  });

  it('is enforced by the database: the application role cannot set the state, not even for an owner who is a professional', async () => {
    const who = await registered(south);

    await expect(
      asTenant(runtime, south.id, (tx) =>
        tx
          .update(professional)
          .set({
            matriculaStatus: 'verified',
            verifiedByOperator: uuidv7(),
            verifiedAt: new Date(),
          })
          .where(eq(professional.id, who.professionalId)),
      ),
    ).rejects.toThrow();
    expect((await rowOf(south, who.professionalId))?.matriculaStatus).toBe('unverified');
  });
});

describe('the operator withdraws a verification', () => {
  it('puts it back to unverified, clears who verified it and audits the withdrawal', async () => {
    const who = await registered(south);
    await verify(south, who);

    const response = await send('POST', unverifyUrl(south, who.professionalId), {
      note: 'El colegio informó una suspensión.',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'unverified', verifiedAt: null });
    expect(await rowOf(south, who.professionalId)).toMatchObject({
      matriculaStatus: 'unverified',
      verifiedByOperator: null,
      verifiedAt: null,
    });
    expect((await profileOf(south, who)).matricula?.status).toBe('unverified');
    const events = await platformEvents('operator.matricula.unverified', who.professionalId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operatorId, targetTenantId: south.id, outcome: 'allow' });
    // The owner sees the withdrawal in the organization's own trail too (JD-S5 R1).
    const [tenantEvent, ...others] = await tenantEvents(
      south,
      'matricula.unverified',
      who.professionalId,
    );
    expect(others).toEqual([]);
    expect(tenantEvent).toMatchObject({ actorUserId: operatorId, outcome: 'allow' });
  });

  it('refuses to withdraw what is not verified', async () => {
    const who = await registered(south);

    const response = await send('POST', unverifyUrl(south, who.professionalId), {});

    expect(response.statusCode).toBe(409);
    expect(await platformEvents('operator.matricula.unverified', who.professionalId)).toEqual([]);
  });
});

describe('editing the number puts the professional back in the queue', () => {
  it('resets the state, so prescribing closes again, and lists them again', async () => {
    const who = await registered(south);
    await verify(south, who);
    expect((await queue()).some((item) => item.professionalId === who.professionalId)).toBe(false);

    const sameNumber = await save(who, south, who.number);
    expect(sameNumber.json<ProfessionalDto>().matricula?.status).toBe('verified');

    const edited = freshNumber();
    const response = await save(who, south, edited);
    expect(response.json<ProfessionalDto>().matricula).toMatchObject({
      number: edited,
      status: 'unverified',
    });
    const item = (await queue()).find((entry) => entry.professionalId === who.professionalId);
    expect(item).toMatchObject({ number: edited, status: 'unverified', verifiedAt: null });
    expect((await rowOf(south, who.professionalId))?.verifiedByOperator).toBeNull();
  });
});

describe('the queue', () => {
  it('lists only unverified registrations, from every organization, with who and where', async () => {
    const pending = await registered(south, 'Ana Gómez');
    const elsewhere = await registered(north, 'Beto Ruiz');
    const decided = await registered(south, 'Carla Sosa');
    await verify(south, decided);

    const items = await queue();

    expect(items.map((item) => item.professionalId)).toEqual(
      expect.arrayContaining([pending.professionalId, elsewhere.professionalId]),
    );
    expect(items.map((item) => item.professionalId)).not.toContain(decided.professionalId);
    expect(items.every((item) => item.status === 'unverified')).toBe(true);
    expect(items.find((item) => item.professionalId === pending.professionalId)).toEqual({
      tenant: { id: south.id, name: 'Consultorio Sur' },
      professionalId: pending.professionalId,
      fullName: 'Ana Gómez',
      jurisdiction: 'AR-B',
      number: pending.number,
      status: 'unverified',
      verifiedAt: null,
      note: null,
    });
    expect(items.find((item) => item.professionalId === elsewhere.professionalId)?.tenant).toEqual({
      id: north.id,
      name: 'Centro Norte',
    });
  });

  it('lists the verified ones on request, so a verification can be withdrawn', async () => {
    const decided = await registered(north, 'Dora Vega');
    await verify(north, decided);

    const items = await queue('verified');

    const item = items.find((entry) => entry.professionalId === decided.professionalId);
    expect(item).toMatchObject({ status: 'verified', fullName: 'Dora Vega' });
    expect(item?.verifiedAt).not.toBeNull();
    expect(items.every((entry) => entry.status === 'verified')).toBe(true);
  });

  it('shows a registration verified out of band with the helper other tracks use in their tests', async () => {
    const who = await registered(north, 'Ines Mora');
    expect((await queue()).some((item) => item.professionalId === who.professionalId)).toBe(true);

    await verifyMatriculaAsOperator(harness.db, north.id, who.professionalId, operatorId);

    expect((await queue()).some((item) => item.professionalId === who.professionalId)).toBe(false);
    const verified = (await queue('verified')).find(
      (item) => item.professionalId === who.professionalId,
    );
    expect(verified).toMatchObject({ status: 'verified', fullName: 'Ines Mora' });
    expect((await profileOf(north, who)).matricula?.status).toBe('verified');
    await expect(
      verifyMatriculaAsOperator(harness.db, south.id, who.professionalId),
    ).rejects.toThrow('no professional to verify');
  });

  it('leaves out inactive professionals and profiles with no registration', async () => {
    const left = await registered(south, 'Eva Luna');
    await asTenant(runtime, south.id, (tx) =>
      tx
        .update(professional)
        .set({ status: 'inactive' })
        .where(eq(professional.id, left.professionalId)),
    );
    const blank = await createTestUser(runtime, south.id, { roles: ['professional'] });
    const blankId = uuidv7();
    await asTenant(runtime, south.id, (tx) =>
      tx
        .insert(professional)
        .values({ id: blankId, tenantId: south.id, membershipId: blank.membershipId }),
    );

    const ids = (await queue()).map((item) => item.professionalId);

    expect(ids).not.toContain(left.professionalId);
    expect(ids).not.toContain(blankId);
  });

  it('refuses a status it does not know', async () => {
    expect((await send('GET', '/operator/matricula-queue?status=all')).statusCode).toBe(400);
  });
});

describe('the operator note', () => {
  it('is saved on its own, replaced, and cleared with an empty text', async () => {
    const who = await registered(south, 'Fabiana Ortiz');
    const find = async () =>
      (await queue()).find((item) => item.professionalId === who.professionalId);

    const saved = await send('PUT', noteUrl(south, who.professionalId), {
      note: 'Esperando respuesta del colegio.',
    });
    expect(saved.statusCode).toBe(200);
    expect((await find())?.note).toBe('Esperando respuesta del colegio.');

    await send('PUT', noteUrl(south, who.professionalId), {
      note: 'Colegio confirmó por teléfono.',
    });
    expect((await find())?.note).toBe('Colegio confirmó por teléfono.');

    await send('PUT', noteUrl(south, who.professionalId), { note: '   ' });
    expect((await find())?.note).toBeNull();
    expect((await rowOf(south, who.professionalId))?.matriculaStatus).toBe('unverified');
  });

  it('is plain and short, and belongs to a real professional of that organization', async () => {
    const who = await registered(south);
    const elsewhere = await registered(north);

    const tooLong = await send('PUT', noteUrl(south, who.professionalId), {
      note: 'x'.repeat(501),
    });
    const crossed = await send('PUT', noteUrl(south, elsewhere.professionalId), { note: 'hola' });
    const extra = await send('PUT', noteUrl(south, who.professionalId), { note: 'hola', extra: 1 });

    expect(tooLong.statusCode).toBe(400);
    expect(crossed.statusCode).toBe(404);
    expect(extra.statusCode).toBe(400);
  });

  it('is not readable by the organization that is the subject of it', async () => {
    const who = await registered(south);
    await send('PUT', noteUrl(south, who.professionalId), { note: 'Solo para la plataforma.' });

    await expect(
      asTenant(runtime, south.id, (tx) =>
        tx.execute(sql`select note from matricula_operator_note`),
      ),
    ).rejects.toThrow();
  });
});

describe('the operator sees nothing clinical', () => {
  it('still cannot read the care tables, the staff accounts or the rest of the profile', async () => {
    for (const table of [
      'encounter',
      'clinical_note',
      'anamnesis',
      'patient',
      'membership',
      'user_account',
    ]) {
      await expect(
        harness.db.db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.tenant_id', ${south.id}, true)`);
          return tx.execute(sql`select 1 from ${sql.identifier(table)} limit 1`);
        }),
        table,
      ).rejects.toThrow();
    }
  });
});

describe('the name the operator sees', () => {
  const nameSeenFrom = (tenantId: string, professionalId: string) =>
    harness.db.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      const result = await tx.execute<{ name: string | null }>(
        sql`select app.operator_professional_name(${professionalId}::uuid) as name`,
      );
      return result.rows[0]?.name ?? null;
    });

  it('is the name of a professional of the organization the transaction is about, and nobody else', async () => {
    const who = await registered(south, 'Gala Rey');

    expect(await nameSeenFrom(south.id, who.professionalId)).toBe('Gala Rey');
    expect(await nameSeenFrom(north.id, who.professionalId)).toBeNull();
  });

  it('cannot be called by the application role', async () => {
    const who = await registered(south);

    await expect(
      asTenant(runtime, south.id, (tx) =>
        tx.execute(sql`select app.operator_professional_name(${who.professionalId}::uuid)`),
      ),
    ).rejects.toThrow();
  });
});

describe('a demo reset', () => {
  it('removes the operator note together with its professional', async () => {
    const demo = await createTestTenant(runtime, {
      slug: 'matricula-demo',
      isDemo: true,
      billingExempt: true,
    });
    const who = await registered(demo, 'Hugo Demo');
    await send('PUT', noteUrl(demo, who.professionalId), { note: 'Nota de prueba.' });
    const notes = () =>
      harness.db.db
        .select({ id: matriculaOperatorNote.id })
        .from(matriculaOperatorNote)
        .where(eq(matriculaOperatorNote.targetTenantId, demo.id));
    expect(await notes()).toHaveLength(1);

    await harness.db.db.execute(sql`SELECT app.demo_reset(${demo.id}::uuid)`);

    expect(await notes()).toEqual([]);
    expect(await rowOf(demo, who.professionalId)).toBeUndefined();
  });
});
