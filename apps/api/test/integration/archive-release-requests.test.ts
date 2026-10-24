import type {
  ArchiveOverviewResponse,
  ArchiveReleaseListResponse,
  ArchiveReleaseRequestDto,
  Problem,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';
import {
  createOperatorHarness,
  createTestClock,
  operatorSession,
  platformHeaders,
  type OperatorHarness,
  type TestClock,
  type TestOperator,
} from '../support/operator.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

/**
 * The operator's side of the break-glass release (tenancy, "Tenant cancellation export"): record a
 * request, verify the identity of the requester out of band, and a DIFFERENT operator approves. The
 * operator never reads the archive: the routes carry requesters and states, and the database refuses
 * what the roles may not do.
 */

let runtime: DbHandle;
let releaserDb: DbHandle;
let harness: OperatorHarness;
let clock: TestClock;
let app: FastifyInstance;
let admin: pg.Client;
let first: TestOperator;
let second: TestOperator;
let third: TestOperator;
let cookieOne: string;
let cookieTwo: string;
let cookieThree: string;
let archived: TestTenant;
let empty: TestTenant;

const PATIENT = {
  requesterKind: 'patient',
  requesterName: 'Ana Ríos',
  requesterEmail: 'ana@ejemplo.test',
  documentType: 'dni',
  document: '20111222',
  reason: 'Necesito mi historia clínica para una segunda opinión',
} as const;
const CHECKLIST = {
  documentChecked: true,
  photoMatches: true,
  contactConfirmed: true,
  entitlementChecked: true,
} as const;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  releaserDb = createRuntimeDb(inject('releaserUrl'));
  harness = createOperatorHarness();
  clock = createTestClock();
  app = buildTestApplication(runtime, {
    operator: { database: harness.db, secrets: harness.secrets },
    clock: clock.read,
    logLevel: 'error',
  });
  first = await harness.addOperator();
  second = await harness.addOperator();
  third = await harness.addOperator();
  cookieOne = await operatorSession(app, first, clock);
  cookieTwo = await operatorSession(app, second, clock);
  cookieThree = await operatorSession(app, third, clock);
  archived = await createTestTenant(runtime, { slug: 'release-requests-archived' });
  empty = await createTestTenant(runtime, { slug: 'release-requests-empty' });
  admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  // An archive that was written (the writer has its own tests): counts and hashes, no content.
  await admin.query(
    `insert into tenant_archive (tenant_id, archive_id, key_version, status, manifest_key, manifest_sha256, objects_count, bytes_total, retain_until, archived_at)
     values ($1, app.uuid_v7(), 1, 'written', 'tenants/x/manifest.json', $2, 12, 123456, now() + interval '3650 days', now())`,
    [archived.id, 'a'.repeat(64)],
  );
  await app.ready();
}, 120_000);

afterAll(async () => {
  await admin.end();
  await app.close();
  await harness.close();
  await releaserDb.close();
  await runtime.close();
});

const call = (method: 'GET' | 'POST', url: string, cookie: string | undefined, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: platformHeaders(cookie),
    remoteAddress: '10.97.0.1',
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

async function record(overrides: Record<string, unknown> = {}, cookie = cookieOne) {
  return call('POST', '/operator/archive-releases', cookie, {
    organization: archived.id,
    ...PATIENT,
    ...overrides,
  });
}

async function platformTrail(requestId: string) {
  const result = await admin.query<{
    action: string;
    operator_id: string | null;
    metadata: { phase: string };
    target_tenant_id: string;
  }>(
    `select action, operator_id, metadata, target_tenant_id from platform_audit_event
      where resource_id = $1 order by occurred_at, id`,
    [requestId],
  );
  return result.rows;
}

describe('recording a request', () => {
  it('records a patient found by document, for an archive that is written, and audits it with the operator', async () => {
    const response = await record();
    const created = response.json<ArchiveReleaseRequestDto>();

    expect(response.statusCode, response.body).toBe(201);
    expect(created).toMatchObject({
      organization: archived.id,
      status: 'requested',
      requesterKind: 'patient',
      requesterName: 'Ana Ríos',
      scope: 'DNI 20111222',
      canVerifyIdentity: true,
      canApprove: false,
      canReject: true,
    });
    expect(await platformTrail(created.id)).toEqual([
      {
        action: 'archive.released',
        operator_id: first.id,
        metadata: { phase: 'recorded', requesterKind: 'patient' },
        target_tenant_id: archived.id,
      },
    ]);
  });

  it('records a professional found by registration', async () => {
    const response = await record({
      requesterKind: 'professional',
      requesterName: 'Dr. Soto',
      requesterEmail: 'soto@ejemplo.test',
      documentType: undefined,
      document: undefined,
      matriculaJurisdiction: 'AR-B',
      matricula: '700123',
      reason: 'Continuidad de la atención de mis pacientes',
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<ArchiveReleaseRequestDto>()).toMatchObject({
      requesterKind: 'professional',
      scope: 'AR-B 700123',
    });
  });

  it('limits the requesters to a patient and a professional, and refuses the fields of the other kind', async () => {
    const lawyer = await record({ requesterKind: 'lawyer' });
    const mixed = await record({ matricula: '123', matriculaJurisdiction: 'AR-B' });
    const nothing = await record({ document: undefined });

    expect(lawyer.statusCode).toBe(400);
    expect(mixed.statusCode).toBe(400);
    expect(nothing.statusCode).toBe(400);
  });

  it('refuses an organization whose archive is not written, and one that does not exist', async () => {
    const withoutArchive = await record({ organization: empty.id });
    const unknown = await record({ organization: '0190a000-0000-7000-8000-00000000dead' });

    expect(withoutArchive.statusCode).toBe(409);
    expect(withoutArchive.json<Problem>().code).toBe('archive_release_no_archive');
    expect(unknown.statusCode).toBe(409);
  });

  it('needs the operator session', async () => {
    const response = await call('POST', '/operator/archive-releases', undefined, {
      organization: archived.id,
      ...PATIENT,
    });
    const listed = await call('GET', '/operator/archive-releases', undefined);

    expect(response.statusCode).toBe(401);
    expect(listed.statusCode).toBe(401);
  });
});

describe('two people', () => {
  it('lets the operator who verified the identity NOT approve, and a different one approve, each with an entry of their own', async () => {
    const created = (await record()).json<ArchiveReleaseRequestDto>();

    const verified = await call(
      'POST',
      `/operator/archive-releases/${created.id}/verify-identity`,
      cookieOne,
      CHECKLIST,
    );
    const sameOperator = await call(
      'POST',
      `/operator/archive-releases/${created.id}/approve`,
      cookieOne,
    );
    const otherOperator = await call(
      'POST',
      `/operator/archive-releases/${created.id}/approve`,
      cookieTwo,
    );

    expect(verified.json<ArchiveReleaseRequestDto>()).toMatchObject({
      status: 'identity_verified',
      canApprove: false,
      canVerifyIdentity: false,
    });
    expect(sameOperator.statusCode).toBe(409);
    expect(sameOperator.json<Problem>().code).toBe('archive_release_same_operator');
    expect(otherOperator.statusCode, otherOperator.body).toBe(200);
    const approved = otherOperator.json<ArchiveReleaseRequestDto>();
    expect(approved.status).toBe('approved');
    // A window of seven days to carry it out, counted from the approval.
    expect(Date.parse(approved.expiresAt ?? '') - Date.parse(approved.approvedAt ?? '')).toBe(
      7 * 86_400_000,
    );
    const trail = await platformTrail(created.id);
    expect(trail.map((entry) => [entry.operator_id, entry.metadata.phase])).toEqual([
      [first.id, 'recorded'],
      [first.id, 'identity_verified'],
      [second.id, 'approved'],
    ]);
  });

  it('shows the second operator that they may approve, and the first that they may not', async () => {
    const created = (await record()).json<ArchiveReleaseRequestDto>();
    await call(
      'POST',
      `/operator/archive-releases/${created.id}/verify-identity`,
      cookieOne,
      CHECKLIST,
    );

    const seenByFirst = (
      await call('GET', '/operator/archive-releases', cookieOne)
    ).json<ArchiveReleaseListResponse>();
    const seenBySecond = (
      await call('GET', '/operator/archive-releases', cookieTwo)
    ).json<ArchiveReleaseListResponse>();

    expect(seenByFirst.requests.find((entry) => entry.id === created.id)?.canApprove).toBe(false);
    expect(seenBySecond.requests.find((entry) => entry.id === created.id)?.canApprove).toBe(true);
  });

  it('refuses to approve what no identity was verified for, and to verify twice', async () => {
    const created = (await record()).json<ArchiveReleaseRequestDto>();

    const early = await call('POST', `/operator/archive-releases/${created.id}/approve`, cookieTwo);
    await call(
      'POST',
      `/operator/archive-releases/${created.id}/verify-identity`,
      cookieOne,
      CHECKLIST,
    );
    const twice = await call(
      'POST',
      `/operator/archive-releases/${created.id}/verify-identity`,
      cookieTwo,
      CHECKLIST,
    );

    expect(early.statusCode).toBe(409);
    expect(early.json<Problem>().code).toBe('archive_release_wrong_step');
    expect(twice.statusCode).toBe(409);
  });

  it('wants every item of the checklist ticked before the identity counts as verified', async () => {
    const created = (await record()).json<ArchiveReleaseRequestDto>();

    for (const item of Object.keys(CHECKLIST)) {
      const response = await call(
        'POST',
        `/operator/archive-releases/${created.id}/verify-identity`,
        cookieOne,
        { ...CHECKLIST, [item]: false },
      );
      expect(response.statusCode, item).toBe(400);
    }
    const [row] = (
      await admin.query<{ status: string }>(
        'select status from archive_release_request where id = $1',
        [created.id],
      )
    ).rows;
    expect(row?.status).toBe('requested');
  });

  it('rejects a request with a reason, from any open step, and then closes it', async () => {
    const created = (await record()).json<ArchiveReleaseRequestDto>();

    const rejected = await call(
      'POST',
      `/operator/archive-releases/${created.id}/reject`,
      cookieTwo,
      {
        reason: 'La persona no pudo acreditar su identidad',
      },
    );
    const after = await call('POST', `/operator/archive-releases/${created.id}/approve`, cookieOne);

    expect(rejected.json<ArchiveReleaseRequestDto>()).toMatchObject({
      status: 'rejected',
      rejectedReason: 'La persona no pudo acreditar su identidad',
      canReject: false,
    });
    expect(after.statusCode).toBe(409);
    const trail = await platformTrail(created.id);
    expect(trail.at(-1)).toMatchObject({ operator_id: second.id, metadata: { phase: 'rejected' } });
  });

  it('answers a request that does not exist with not found', async () => {
    const response = await call(
      'POST',
      '/operator/archive-releases/0190a000-0000-7000-8000-00000000dead/approve',
      cookieOne,
    );

    expect(response.statusCode).toBe(404);
  });
});

describe('what the operator can and cannot reach', () => {
  it('never gets a record, a key or a name of an object: a request is a requester and a scope, an archive is counts', async () => {
    const list = await call('GET', '/operator/archive-releases', cookieOne);
    const archives = await call('GET', '/operator/archives', cookieOne);
    expect(archives.statusCode, archives.body).toBe(200);
    const overview = archives.json<ArchiveOverviewResponse>();

    expect(list.statusCode).toBe(200);
    expect(list.body).not.toMatch(/packageKey|package_key|manifest|tenants\//);
    expect(overview.archives.find((entry) => entry.organization === archived.id)).toMatchObject({
      status: 'written',
      objects: 12,
      bytes: 123456,
    });
    expect(archives.body).not.toMatch(/manifest|key|tenants\//i);
  });

  it('has no privilege on the archive tables, the keys or the packages', async () => {
    const attempt = (statement: ReturnType<typeof sql>) =>
      harness.db.db
        .transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('app.tenant_id', ${archived.id}, true), set_config('app.user_id', ${archived.id}, true)`,
          );
          await tx.execute(statement);
        })
        .then(
          () => 'allowed',
          (error: unknown) => (error as { cause?: { code?: string } }).cause?.code ?? 'error',
        );

    expect(await attempt(sql`select * from tenant_archive`)).toBe('42501');
    expect(await attempt(sql`select * from archive_key`)).toBe('42501');
    expect(await attempt(sql`select * from export_package where false and file_name is null`)).toBe(
      '42501',
    );
    // And it can not write the delivery of a request: the package, the link, the release.
    expect(await attempt(sql`update archive_release_request set package_key = 'x'`)).toBe('42501');
    expect(await attempt(sql`update archive_release_request set released_at = now()`)).toBe(
      '42501',
    );
    expect(await attempt(sql`delete from archive_release_request`)).toBe('42501');
  });

  it('can not release a request itself: the status moves only along the steps of its role, with the name of the operator on the step', async () => {
    const created = (await record()).json<ArchiveReleaseRequestDto>();
    const attempt = (update: string, actor: string | null) =>
      harness.db.db
        .transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.tenant_id', ${archived.id}, true)`);
          if (actor !== null) {
            await tx.execute(sql`select set_config('app.user_id', ${actor}, true)`);
          }
          await tx.execute(
            sql.raw(
              `update archive_release_request set ${update} where id = '${created.id}'::uuid`,
            ),
          );
        })
        .then(
          () => 'allowed',
          (error: unknown) => (error as { cause?: { code?: string } }).cause?.code ?? 'error',
        );
    const verify = (who: string) =>
      `status = 'identity_verified', identity_verified_by = '${who}'::uuid, identity_verified_at = now(), identity_checklist = '{"documentChecked": true, "photoMatches": true, "contactConfirmed": true, "entitlementChecked": true}'::jsonb`;

    // Skipping the identity step, or releasing, is not the operator's.
    expect(await attempt(`status = 'approved'`, first.id)).toBe('42501');
    expect(await attempt(`status = 'released'`, first.id)).toBe('42501');
    // The step must carry the operator of the session: another name, or none, is refused.
    expect(await attempt(verify(second.id), first.id)).toBe('42501');
    expect(await attempt(verify(first.id), null)).toBe('42501');
    expect(await attempt(verify(first.id), first.id)).toBe('allowed');
  });

  it('is invisible to the runtime role of another organization, and read-only for its own: it can not approve or insert', async () => {
    const created = (await record()).json<ArchiveReleaseRequestDto>();

    const elsewhere = await asTenant(runtime, empty.id, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from archive_release_request`),
    );
    const own = await asTenant(runtime, archived.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from archive_release_request where id = ${created.id}::uuid`,
      ),
    );
    const attempt = (statement: ReturnType<typeof sql>) =>
      asTenant(runtime, archived.id, (tx) => tx.execute(statement)).then(
        () => 'allowed',
        (error: unknown) => (error as { cause?: { code?: string } }).cause?.code ?? 'error',
      );

    expect(elsewhere.rows[0]?.n).toBe(0);
    expect(own.rows[0]?.n).toBe(1);
    expect(
      await attempt(
        sql`update archive_release_request set status = 'approved' where id = ${created.id}::uuid`,
      ),
    ).toBe('42501');
    expect(
      await attempt(
        sql`update archive_release_request set requester_email = 'otro@x.test' where id = ${created.id}::uuid`,
      ),
    ).toBe('42501');
    expect(await attempt(sql`delete from archive_release_request`)).toBe('42501');
    expect(
      await attempt(
        sql`insert into archive_release_request (target_tenant_id, requester_kind, requester_name, requester_email, scope_document_type, scope_document, reason, recorded_by)
            values (${archived.id}::uuid, 'patient', 'Falso', 'f@x.test', 'dni', '1', 'razón falsa', ${archived.id}::uuid)`,
      ),
    ).toBe('42501');
  });

  it('is held by the database to two people and to the checklist, whatever the application does', async () => {
    const created = (await record()).json<ArchiveReleaseRequestDto>();
    const oneUpdate = (statement: string) =>
      admin.query(statement, [created.id, first.id]).then(
        () => 'allowed',
        (error: unknown) => (error as { code?: string }).code ?? 'error',
      );

    // 23514: a check constraint. The same person on both steps, and a checklist with a gap.
    expect(
      await oneUpdate(
        `update archive_release_request set status = 'approved', identity_verified_by = $2, identity_verified_at = now(), approved_by = $2, approved_at = now(), expires_at = now() + interval '7 days', identity_checklist = '{"documentChecked": true, "photoMatches": true, "contactConfirmed": true, "entitlementChecked": true}'::jsonb where id = $1`,
      ),
    ).toBe('23514');
    expect(
      await oneUpdate(
        `update archive_release_request set status = 'identity_verified', identity_verified_by = $2, identity_verified_at = now(), identity_checklist = '{"documentChecked": true}'::jsonb where id = $1`,
      ),
    ).toBe('23514');
  });
});

describe('three pairs of eyes (JD-S6 R1-S6-4)', () => {
  const verifyUrl = (id: string) => `/operator/archive-releases/${id}/verify-identity`;
  const approveUrl = (id: string) => `/operator/archive-releases/${id}/approve`;

  it('lets neither the operator who recorded the request nor the one who verified it approve; a third one can', async () => {
    const created = (await record({}, cookieOne)).json<ArchiveReleaseRequestDto>();
    await call('POST', verifyUrl(created.id), cookieTwo, CHECKLIST);

    const byRecorder = await call('POST', approveUrl(created.id), cookieOne);
    const byVerifier = await call('POST', approveUrl(created.id), cookieTwo);
    const byThird = await call('POST', approveUrl(created.id), cookieThree);

    expect(byRecorder.statusCode, byRecorder.body).toBe(409);
    expect(byRecorder.json<Problem>().code).toBe('archive_release_same_operator');
    expect(byVerifier.statusCode).toBe(409);
    expect(byThird.statusCode, byThird.body).toBe(200);
    expect(byThird.json<ArchiveReleaseRequestDto>().status).toBe('approved');
  });

  it('shows the recorder, and the verifier, that they may not approve, and the third operator that they may', async () => {
    const created = (await record({}, cookieOne)).json<ArchiveReleaseRequestDto>();
    await call('POST', verifyUrl(created.id), cookieTwo, CHECKLIST);

    const seen = async (cookie: string) =>
      (await call('GET', '/operator/archive-releases', cookie))
        .json<ArchiveReleaseListResponse>()
        .requests.find((entry) => entry.id === created.id)?.canApprove;

    expect(await seen(cookieOne)).toBe(false);
    expect(await seen(cookieTwo)).toBe(false);
    expect(await seen(cookieThree)).toBe(true);
  });

  it('is held by the database: the approver is not the recorder, whatever the application does', async () => {
    const created = (await record({}, cookieOne)).json<ArchiveReleaseRequestDto>();
    const ticked = `'{"documentChecked": true, "photoMatches": true, "contactConfirmed": true, "entitlementChecked": true}'::jsonb`;

    const result = await admin
      .query(
        `update archive_release_request set status = 'approved', identity_verified_by = $2, identity_verified_at = now(), identity_checklist = ${ticked}, approved_by = $3, approved_at = now(), expires_at = now() + interval '7 days' where id = $1`,
        [created.id, second.id, first.id],
      )
      .then(
        () => 'allowed',
        (error: unknown) => (error as { constraint?: string }).constraint ?? 'error',
      );

    expect(result).toBe('archive_release_request_recorder_check');
  });
});

describe('who took a step cannot be rewritten (JD-S6 R2-2)', () => {
  const verifyUrl = (id: string) => `/operator/archive-releases/${id}/verify-identity`;
  /** A connection as the operator role, with the operator of the session set the way the application sets it. */
  async function asOperator<T>(operatorId: string, work: (client: pg.Client) => Promise<T>) {
    const client = new pg.Client({ connectionString: inject('operatorUrl') });
    await client.connect();
    try {
      await client.query("select set_config('app.user_id', $1, false)", [operatorId]);
      return await work(client);
    } finally {
      await client.end();
    }
  }
  const refusal = (client: pg.Client, sql: string, values: unknown[]) =>
    client.query(sql, values).then(
      () => 'allowed',
      (error: unknown) => (error as { message?: string }).message ?? 'error',
    );

  it('refuses a same-status update that rewrites who verified or approved, and an approval that overwrites the verifier', async () => {
    const approved = (await record({}, cookieOne)).json<ArchiveReleaseRequestDto>();
    await call('POST', verifyUrl(approved.id), cookieTwo, CHECKLIST);
    const verified = (await record({}, cookieOne)).json<ArchiveReleaseRequestDto>();
    await call('POST', verifyUrl(verified.id), cookieTwo, CHECKLIST);
    await call('POST', `/operator/archive-releases/${approved.id}/approve`, cookieThree);

    await asOperator(third.id, async (client) => {
      // Same status: nobody can put another name on a step that was taken.
      expect(
        await refusal(
          client,
          'update archive_release_request set identity_verified_by = $2 where id = $1',
          [approved.id, third.id],
        ),
      ).toMatch(/does not change/);
      expect(
        await refusal(client, 'update archive_release_request set approved_by = $2 where id = $1', [
          approved.id,
          first.id,
        ]),
      ).toMatch(/does not change/);
      expect(
        await refusal(client, 'update archive_release_request set recorded_by = $2 where id = $1', [
          approved.id,
          third.id,
        ]),
      ).toMatch(/does not change|permission denied/);
      // An approval that also overwrites the verifier is refused, even with the approver's own name.
      expect(
        await refusal(
          client,
          "update archive_release_request set status = 'approved', approved_by = $2, approved_at = now(), identity_verified_by = $2, expires_at = now() + interval '7 days' where id = $1",
          [verified.id, third.id],
        ),
      ).toMatch(/does not change/);
    });
    const row = await admin.query<{ identity_verified_by: string; approved_by: string | null }>(
      'select identity_verified_by, approved_by from archive_release_request where id = any($1)',
      [[approved.id, verified.id]],
    );
    expect(row.rows.map((entry) => entry.identity_verified_by)).toEqual([second.id, second.id]);
  });

  it('binds the recorder to the operator of the session when a request is inserted', async () => {
    const result = await asOperator(first.id, (client) =>
      refusal(
        client,
        `insert into archive_release_request (target_tenant_id, requester_kind, requester_name, requester_email, scope_document_type, scope_document, reason, recorded_by)
         values ($1, 'patient', 'Ana', 'ana@ejemplo.test', 'dni', '123', 'una razon larga y suficiente', $2)`,
        [archived.id, second.id],
      ),
    );

    expect(result).toMatch(/recorded by the operator of the session/);
  });
});

describe('two operators at the same step at once (JD-S6 R3-2)', () => {
  const verifyUrl = (id: string) => `/operator/archive-releases/${id}/verify-identity`;
  const approveUrl = (id: string) => `/operator/archive-releases/${id}/approve`;
  const rejectUrl = (id: string) => `/operator/archive-releases/${id}/reject`;
  const outcome = (responses: { statusCode: number; json(): unknown }[]) =>
    responses
      .map((response) => [
        response.statusCode,
        response.statusCode === 200 ? 'ok' : (response.json() as Problem).code,
      ])
      .sort((a, b) => Number(a[0]) - Number(b[0]));

  it('lets one verification through and answers the other that the request is no longer at that step', async () => {
    const created = (await record({}, cookieOne)).json<ArchiveReleaseRequestDto>();

    const answers = await Promise.all([
      call('POST', verifyUrl(created.id), cookieTwo, CHECKLIST),
      call('POST', verifyUrl(created.id), cookieThree, CHECKLIST),
    ]);

    expect(outcome(answers)).toEqual([
      [200, 'ok'],
      [409, 'archive_release_wrong_step'],
    ]);
  });

  it('lets one approval through and answers the other that the request is no longer at that step', async () => {
    const fourth = await harness.addOperator();
    const cookieFour = await operatorSession(app, fourth, clock);
    const created = (await record({}, cookieOne)).json<ArchiveReleaseRequestDto>();
    await call('POST', verifyUrl(created.id), cookieTwo, CHECKLIST);

    const answers = await Promise.all([
      call('POST', approveUrl(created.id), cookieThree),
      call('POST', approveUrl(created.id), cookieFour),
    ]);

    expect(outcome(answers)).toEqual([
      [200, 'ok'],
      [409, 'archive_release_wrong_step'],
    ]);
  });

  it('lets one rejection through and answers the other that the request is no longer at that step', async () => {
    const created = (await record({}, cookieOne)).json<ArchiveReleaseRequestDto>();
    const reason = { reason: 'La persona no pudo acreditar su identidad' };

    const answers = await Promise.all([
      call('POST', rejectUrl(created.id), cookieTwo, reason),
      call('POST', rejectUrl(created.id), cookieThree, reason),
    ]);

    expect(outcome(answers)).toEqual([
      [200, 'ok'],
      [409, 'archive_release_wrong_step'],
    ]);
  });
});

describe('a request that waits for too long (JD-S6 R1-S6-4)', () => {
  const age = (id: string, days: number) =>
    admin.query(
      `update archive_release_request set created_at = now() - make_interval(days => $2) where id = $1`,
      [id, days],
    );
  const status = async (id: string) =>
    (
      await admin.query<{ status: string }>(
        'select status from archive_release_request where id = $1',
        [id],
      )
    ).rows[0]?.status;

  it('can not be verified or approved after seven days', async () => {
    const stale = (await record()).json<ArchiveReleaseRequestDto>();
    const verifiedStale = (await record()).json<ArchiveReleaseRequestDto>();
    await call(
      'POST',
      `/operator/archive-releases/${verifiedStale.id}/verify-identity`,
      cookieOne,
      CHECKLIST,
    );
    await age(stale.id, 8);
    await age(verifiedStale.id, 8);

    const verify = await call(
      'POST',
      `/operator/archive-releases/${stale.id}/verify-identity`,
      cookieOne,
      CHECKLIST,
    );
    const approve = await call(
      'POST',
      `/operator/archive-releases/${verifiedStale.id}/approve`,
      cookieTwo,
    );

    expect(verify.statusCode, verify.body).toBe(409);
    expect(approve.statusCode, approve.body).toBe(409);
    expect(approve.json<Problem>().code).toBe('archive_release_wrong_step');
  });

  it('is closed by the releaser: requested and identity_verified expire, a fresh one and an approved one stay', async () => {
    const requested = (await record()).json<ArchiveReleaseRequestDto>();
    const verified = (await record()).json<ArchiveReleaseRequestDto>();
    await call(
      'POST',
      `/operator/archive-releases/${verified.id}/verify-identity`,
      cookieOne,
      CHECKLIST,
    );
    const fresh = (await record()).json<ArchiveReleaseRequestDto>();
    const approved = (await record()).json<ArchiveReleaseRequestDto>();
    await call(
      'POST',
      `/operator/archive-releases/${approved.id}/verify-identity`,
      cookieOne,
      CHECKLIST,
    );
    await call('POST', `/operator/archive-releases/${approved.id}/approve`, cookieTwo);
    for (const id of [requested.id, verified.id, approved.id]) await age(id, 9);

    const closed = await releaserDb.db.transaction((tx) =>
      tx.execute<{ closed: number }>(sql`select app.archive_release_expire_stale(7) as closed`),
    );

    expect(closed.rows[0]?.closed).toBeGreaterThanOrEqual(2);
    expect(await status(requested.id)).toBe('expired');
    expect(await status(verified.id)).toBe('expired');
    expect(await status(fresh.id)).toBe('requested');
    // An approved request has its own window (`expires_at`), which the releaser works.
    expect(await status(approved.id)).toBe('approved');
    expect((await platformTrail(requested.id)).at(-1)).toMatchObject({
      action: 'archive.released',
      operator_id: null,
      metadata: { phase: 'expired' },
    });
  });

  it('is a power of the releaser only: the role of the API and the worker can not call it', async () => {
    const attempt = await asTenant(runtime, archived.id, (tx) =>
      tx.execute(sql`select app.archive_release_expire_stale(7)`),
    ).then(
      () => 'allowed',
      (error: unknown) => (error as { cause?: { code?: string } }).cause?.code ?? 'error',
    );

    expect(attempt).toBe('42501');
  });
});
