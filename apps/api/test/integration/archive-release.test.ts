import { randomUUID } from 'node:crypto';

import type { ArchiveReleaseRequestDto, Problem } from '@consultorio/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  createFakeArchiveStore,
  type FakeArchiveStore,
} from '../../src/adapters/archive-fake/index.js';
import { generateReleaserKeys } from '../../src/modules/tenancy/archive/archive-crypto.js';
import {
  abandonDownload,
  claimDownload,
  completeDownload,
  MAX_DOWNLOAD_ATTEMPTS,
} from '../../src/modules/tenancy/archive/download.js';
import {
  createArchiveKeyReleaser,
  createArchiveKeyWriter,
} from '../../src/modules/tenancy/archive/keys.js';
import { parseManifest } from '../../src/modules/tenancy/archive/manifest.js';
import {
  ARCHIVE_RELEASE_JOB,
  createArchiveReleaseJob,
  type ArchiveReleaseDeps,
} from '../../src/modules/tenancy/archive/release-archive.js';
import { sweepReleases } from '../../src/modules/tenancy/archive/releaser.js';
import {
  ARCHIVE_WRITE_JOB,
  createArchiveWriteJob,
} from '../../src/modules/tenancy/archive/write-archive.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, SYSTEM_USER_ID, type Tx } from '../../src/platform/db/tenant-context.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import { createActionTokens } from '../../src/platform/tokens/index.js';
import { browserHeaders } from '../support/app.js';
import type { Professional } from '../support/clinical-world.js';
import { createRecordingJobClient } from '../support/jobs.js';
import { operatorSession, platformHeaders } from '../support/operator.js';
import { createRetentionWorld, type RetentionWorld } from '../support/retention-world.js';
import { createTestTenant } from '../support/tenants.js';
import { allTextOf, readZip } from '../support/zip-reader.js';

/**
 * The break-glass release (tenancy, "Tenant cancellation export": records in the custody of the platform
 * are released only to the patient themselves, identity verified, or to a verified professional, with an
 * audit entry, and the operator cannot read the content). The operators verify and approve; the
 * releaser, which alone holds the key, decrypts the scope and emails a single-use link; the operator
 * sees none of it. These tests go through the real application, the real database, the real archive
 * jobs and the real contributors, with the in-memory store.
 */

let runtime: DbHandle;
/** The connection of the releaser: its own database role (`app_releaser`), JD-S6 R1-S6-12. */
let releaserDb: DbHandle;
let org: RetentionWorld;
let admin: pg.Client;
let store: FakeArchiveStore;
let releaser: { kek: string; publicKey: string };
let doctorA: Professional;
let doctorB: Professional;
let secondOperatorCookie: string;
let secondOperatorId: string;
let matriculaOfA: { jurisdiction: string; number: string };

const ANA_DOCUMENT = '20111222';
const BRUNO_DOCUMENT = '30999888';
const NOTE_ANA = 'Lumbalgia crónica de Ana Ríos, controlada por A';
const NOTE_BRUNO = 'Migraña con aura de Bruno Soto, controlada por B';
const SLUG = 'archive-release';
const REQUESTER = 'ana.rios@ejemplo.test';

const withTenant = () => createWithTenant(runtime.db);
const releaserWithTenant = () => createWithTenant(releaserDb.db);
/** The API serves the link as the runtime role: its steps of the download run as it does. */
const runtimeWithTenant = <T>(
  context: { tenantId: string; userId: string },
  work: (tx: Tx) => Promise<T>,
) => withTenant()(context, work);
const clock = () => org.operator.clock.read();

function releaseJob(overrides: Partial<ArchiveReleaseDeps> = {}) {
  return createArchiveReleaseJob({
    withTenant: releaserWithTenant(),
    store,
    storage: org.storage,
    keys: createArchiveKeyReleaser({ kek: releaser.kek }),
    tokens: createActionTokens({ clock }),
    email: org.email,
    origins: (slug) => `https://${slug}.consultorio.test`,
    clock,
    ...overrides,
  });
}

const runRelease = (
  requestId: string,
  retryCount = 0,
  overrides: Partial<ArchiveReleaseDeps> = {},
) =>
  runJob(releaserDb.db, releaseJob(overrides), {
    id: randomUUID(),
    name: ARCHIVE_RELEASE_JOB,
    data: { tenantId: org.world.tenant.id, requestId },
    enqueuedAt: new Date(),
    retryCount,
  });

const asOperator = (method: 'GET' | 'POST', url: string, cookie: string, payload?: unknown) =>
  org.world.app.inject({
    method,
    url,
    headers: platformHeaders(cookie),
    remoteAddress: '10.97.0.1',
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const CHECKLIST = {
  documentChecked: true,
  photoMatches: true,
  contactConfirmed: true,
  entitlementChecked: true,
} as const;

/** Records, verifies (one operator) and approves (the other): a request ready to be carried out. */
async function approvedRequest(overrides: Record<string, unknown> = {}): Promise<string> {
  const recorded = await asOperator('POST', '/operator/archive-releases', org.operator.cookie, {
    organization: org.world.tenant.id,
    requesterKind: 'patient',
    requesterName: 'Ana Ríos',
    requesterEmail: REQUESTER,
    documentType: 'dni',
    document: ANA_DOCUMENT,
    reason: 'Necesito mi historia clínica para una segunda opinión',
    ...overrides,
  });
  expect(recorded.statusCode, recorded.body).toBe(201);
  const { id } = recorded.json<ArchiveReleaseRequestDto>();
  const verified = await asOperator(
    'POST',
    `/operator/archive-releases/${id}/verify-identity`,
    org.operator.cookie,
    CHECKLIST,
  );
  expect(verified.statusCode, verified.body).toBe(200);
  const approved = await asOperator(
    'POST',
    `/operator/archive-releases/${id}/approve`,
    secondOperatorCookie,
  );
  expect(approved.statusCode, approved.body).toBe(200);
  return id;
}

const tokenFrom = (to: string): string => {
  const message = org.email.lastTo(to);
  const match = /archive-release\/([A-Za-z0-9_-]{43})/.exec(message?.text ?? '');
  if (!match?.[1]) throw new Error(`no release link was sent to ${to}`);
  return match[1];
};

const linkCall = (method: 'GET' | 'POST', token: string, slug = SLUG) =>
  org.world.app.inject({
    method,
    url: `/public/${slug}/archive-release/${token}`,
    headers: browserHeaders(slug),
    remoteAddress: '10.97.0.2',
  });

async function requestRow(id: string) {
  const result = await admin.query<{
    status: string;
    failure_code: string | null;
    package_key: string | null;
    downloaded_at: Date | null;
    package_removed_at: Date | null;
    link_expires_at: Date | null;
  }>(
    'select status, failure_code, package_key, downloaded_at, package_removed_at, link_expires_at from archive_release_request where id = $1',
    [id],
  );
  return result.rows[0];
}

/** The download is recorded when the transfer ends, after the answer: wait for it. */
async function downloaded(id: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = await requestRow(id);
    if (row?.downloaded_at) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return requestRow(id);
}

async function trail(requestId: string) {
  const result = await admin.query<{
    action: string;
    operator_id: string | null;
    reason: string | null;
    metadata: { phase?: string };
  }>(
    'select action, operator_id, reason, metadata from platform_audit_event where resource_id = $1 order by occurred_at, id',
    [requestId],
  );
  return result.rows;
}

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  releaserDb = createRuntimeDb(inject('releaserUrl'));
  admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  releaser = generateReleaserKeys();
  org = await createRetentionWorld(runtime, SLUG);
  store = createFakeArchiveStore({ clock });
  const { world } = org;

  const second = await org.operator.harness.addOperator();
  secondOperatorId = second.id;
  secondOperatorCookie = await operatorSession(world.app, second, org.operator.clock);

  doctorA = await world.professional();
  doctorB = await world.professional();
  const register = async (familyName: string, number: string) => {
    const created = await world.api.post('/patients', world.reception, {
      familyName,
      givenNames: 'Paciente',
      birthDate: '1980-03-04',
      document: { type: 'dni', number },
      dataProcessingConsent: true,
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json<{ patient: { id: string } }>().patient.id;
  };
  const ana = await register('Ríos', ANA_DOCUMENT);
  const bruno = await register('Soto', BRUNO_DOCUMENT);
  const { careAssignment } = await import('../../src/db/schema/care.js');
  const { asTenant } = await import('../support/tenants.js');
  for (const [patient, professional] of [
    [ana, doctorA],
    [bruno, doctorB],
  ] as const) {
    await asTenant(runtime, world.tenant.id, (tx) =>
      tx.insert(careAssignment).values({
        tenantId: world.tenant.id,
        patientId: patient,
        professionalId: professional.professionalId,
        assignedBy: randomUUID(),
      }),
    );
  }
  await org.signedEntry(doctorA, ana, { reasonForConsultation: NOTE_ANA });
  await org.signedEntry(doctorB, bruno, { reasonForConsultation: NOTE_BRUNO });
  const profile = await admin.query<{ matricula: string; matricula_jurisdiction: string }>(
    'select matricula, matricula_jurisdiction from professional where id = $1',
    [doctorA.professionalId],
  );
  matriculaOfA = {
    jurisdiction: profile.rows[0]?.matricula_jurisdiction ?? '',
    number: profile.rows[0]?.matricula ?? '',
  };

  expect((await org.cancel()).statusCode).toBe(200);
  await org.buildPackages();
  // The archive, written at once (no window), with the in-memory store.
  const writer = createArchiveWriteJob({
    exports: org.exports,
    withTenant: withTenant(),
    storage: org.storage,
    store,
    keys: createArchiveKeyWriter({
      withTenant: withTenant(),
      releaserPublicKey: releaser.publicKey,
    }),
    clock: () => new Date(),
    retentionDays: 3650,
    afterDays: 0,
  });
  const written = await runJob(runtime.db, writer, {
    id: randomUUID(),
    name: ARCHIVE_WRITE_JOB,
    data: { tenantId: world.tenant.id },
    enqueuedAt: new Date(),
    retryCount: 0,
  });
  expect(written.status).toBe('completed');
}, 300_000);

afterAll(async () => {
  await admin.end();
  await org.close();
  await releaserDb.close();
  await runtime.close();
});

describe('a patient asks for their own records', () => {
  let requestId: string;
  let token: string;

  it('is carried out by the releaser once it is approved: the requester gets a link and the former contact a notice', async () => {
    requestId = await approvedRequest();
    const jobs = createRecordingJobClient();

    // The releaser looks for approved requests and queues the job for each.
    const swept = await sweepReleases({
      db: releaserDb.db,
      withTenant: releaserWithTenant(),
      client: jobs,
      storage: org.storage,
      clock,
    });
    const result = await runRelease(requestId);
    const row = await requestRow(requestId);

    expect(swept.queued).toBeGreaterThanOrEqual(1);
    // Other files of the shared database may have approved requests of their own: look for ours.
    expect(
      jobs.jobs.find(
        (job) => job.name === ARCHIVE_RELEASE_JOB && job.payload.requestId === requestId,
      )?.payload,
    ).toMatchObject({
      tenantId: org.world.tenant.id,
      requestId,
    });
    expect(result.status).toBe('completed');
    expect(row).toMatchObject({ status: 'released', failure_code: null });
    expect(row?.package_key).toBe(`t/${org.world.tenant.id}/archive-release/${requestId}.zip`);
    // The link lives 72 hours.
    expect((row?.link_expires_at?.getTime() ?? 0) - clock().getTime()).toBe(72 * 3_600_000);

    const toRequester = org.email.lastTo(REQUESTER);
    token = tokenFrom(REQUESTER);
    expect(toRequester?.subject).toContain('Su copia de los registros archivados');
    expect(toRequester?.text).toContain(
      `https://${SLUG}.consultorio.test/archive-release/${token}`,
    );
    expect(toRequester?.text).not.toContain(NOTE_ANA);
    // The former contact (the owner) is told, without the name or the document of the requester.
    const toOwner = org.email.sent.filter(
      (message) =>
        message.to === org.world.owner.user.email && /Se entregó una copia/.test(message.subject),
    );
    expect(toOwner).toHaveLength(1);
    expect(toOwner[0]?.text).not.toMatch(/Ana|Ríos|20111222/);
    expect(toOwner[0]?.text).toContain('un paciente');
  });

  it('looks at the link without spending it, and says only when it ends', async () => {
    const first = await linkCall('GET', token);
    const second = await linkCall('GET', token);

    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json<{ expiresAt: string }>().expiresAt).toBe(
      new Date(clock().getTime() + 72 * 3_600_000).toISOString(),
    );
    expect(Object.keys(first.json<object>())).toEqual(['expiresAt']);
  });

  it("hands over the package once: the rows of the patient and nobody else's", async () => {
    const download = await linkCall('POST', token);

    expect(download.statusCode, download.body).toBe(200);
    expect(download.headers['content-type']).toBe('application/zip');
    expect(download.headers['content-disposition']).toMatch(
      /^attachment; filename="registros-archivados\.zip"$/,
    );
    expect(download.headers['cache-control']).toBe('no-store');
    const files = readZip(download.rawPayload);
    const text = allTextOf(files);
    expect(text).toContain(NOTE_ANA);
    expect(text).toContain('Ríos');
    expect(text).not.toContain(NOTE_BRUNO);
    expect(text).not.toContain('Soto');
    expect(files.has('manifiesto.json')).toBe(true);
    expect(files.get('resumen.pdf')?.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('can not be used a second time, by the link or by looking at it', async () => {
    // The use of the link is counted when the transfer ends.
    expect((await downloaded(requestId))?.downloaded_at).not.toBeNull();
    const again = await linkCall('POST', token);
    const looking = await linkCall('GET', token);

    expect(again.statusCode).toBe(404);
    expect(looking.statusCode).toBe(404);
    expect(again.json<Problem>().code).toBe('not_found');
  });

  it('takes the package out of the bucket once it was downloaded', async () => {
    const key = `t/${org.world.tenant.id}/archive-release/${requestId}.zip`;
    // The object goes first and the mark follows in its own transaction: wait for both.
    let removed = false;
    let row = await requestRow(requestId);
    for (let attempt = 0; attempt < 100 && !(removed && row?.package_removed_at); attempt += 1) {
      removed = (await org.storage.head(org.world.tenant.id, key)) === null;
      row = await requestRow(requestId);
      if (!(removed && row?.package_removed_at)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    expect(removed).toBe(true);
    expect(row?.downloaded_at).not.toBeNull();
    expect(row?.package_removed_at).not.toBeNull();
  });

  it('leaves every step in the platform trail: the two operators, then the releaser, never content', async () => {
    const steps = await trail(requestId);

    expect(steps.map((step) => [step.action, step.metadata.phase ?? '', step.operator_id])).toEqual(
      [
        ['archive.released', 'recorded', org.operator.id],
        ['archive.released', 'identity_verified', org.operator.id],
        ['archive.released', 'approved', secondOperatorId],
        ['archive.accessed', 'decrypt', null],
        ['archive.released', 'delivered', null],
        ['archive.released', 'downloaded', null],
      ],
    );
    // Opening the archive carries the reason that was stated, who and when.
    expect(steps.find((step) => step.action === 'archive.accessed')?.reason).toBe(
      'Necesito mi historia clínica para una segunda opinión',
    );
    expect(JSON.stringify(steps)).not.toContain(NOTE_ANA);
  });

  it('does not work on the host of another organization: the link belongs to the one that was archived', async () => {
    await createTestTenant(runtime, { slug: 'archive-release-other' });
    const fresh = await approvedRequest();
    await runRelease(fresh);
    const second = tokenFrom(REQUESTER);

    const elsewhere = await org.world.app.inject({
      method: 'POST',
      url: '/public/archive-release-other/archive-release/' + second,
      headers: browserHeaders('archive-release-other'),
      remoteAddress: '10.97.0.2',
    });
    const wrongSlug = await linkCall('POST', second, 'archive-release-other');

    expect(elsewhere.statusCode).toBe(404);
    expect(wrongSlug.statusCode).toBe(404);
    // The right host still opens it: nothing was spent by the wrong ones.
    expect((await linkCall('GET', second)).statusCode).toBe(200);
  });
});

describe('a professional asks for the records of their patients', () => {
  it('receives their own clinical package and not the records of a colleague', async () => {
    const id = await approvedRequest({
      requesterKind: 'professional',
      requesterName: 'Dra. Prueba',
      requesterEmail: 'dra.prueba@ejemplo.test',
      documentType: undefined,
      document: undefined,
      matriculaJurisdiction: matriculaOfA.jurisdiction,
      matricula: matriculaOfA.number,
      reason: 'Continuidad de la atención de mis pacientes',
    });

    const result = await runRelease(id);
    const download = await linkCall('POST', tokenFrom('dra.prueba@ejemplo.test'));
    const text = allTextOf(readZip(download.rawPayload));

    expect(result.status).toBe('completed');
    expect(download.statusCode, download.body).toBe(200);
    expect(text).toContain(NOTE_ANA);
    expect(text).not.toContain(NOTE_BRUNO);
    expect((await requestRow(id))?.status).toBe('released');
    expect(
      org.email.sent.filter((message) => /Se entregó una copia/.test(message.subject)).at(-1)?.text,
    ).toContain('un profesional');
  });
});

describe('what the releaser refuses', () => {
  it('fails a request whose scope is not in the archive, and sends the requester nothing', async () => {
    const before = org.email.sent.length;
    const patient = await approvedRequest({
      document: '11111111',
      requesterEmail: 'nadie@ejemplo.test',
    });
    const professional = await approvedRequest({
      requesterKind: 'professional',
      requesterEmail: 'nadie.prof@ejemplo.test',
      documentType: undefined,
      document: undefined,
      matriculaJurisdiction: 'AR-Z',
      matricula: '99',
      reason: 'Continuidad de la atención de mis pacientes',
    });

    await runRelease(patient);
    await runRelease(professional);

    expect(await requestRow(patient)).toMatchObject({
      status: 'failed',
      failure_code: 'scope_not_found',
    });
    expect(await requestRow(professional)).toMatchObject({
      status: 'failed',
      failure_code: 'scope_not_found',
    });
    expect(org.email.sent.slice(before).some((message) => /nadie/.test(message.to))).toBe(false);
    const steps = await trail(patient);
    expect(steps.at(-1)?.metadata).toMatchObject({ phase: 'failed', code: 'scope_not_found' });
  });

  it('can not decrypt anything without the right key: a wrong key opens nothing and nothing is sent', async () => {
    const before = org.email.sent.length;
    const id = await approvedRequest({ requesterEmail: 'sinclave@ejemplo.test' });
    const wrong = createArchiveKeyReleaser({ kek: generateReleaserKeys().kek });

    // First delivery: the queue tries again. Last delivery: the request ends failed, with a code.
    await expect(runRelease(id, 0, { keys: wrong })).rejects.toThrow();
    const last = await runRelease(id, 1, { keys: wrong });

    expect(last.status).toBe('completed');
    expect(await requestRow(id)).toMatchObject({
      status: 'failed',
      failure_code: 'release_failed',
    });
    expect(
      org.email.sent.slice(before).some((message) => message.to === 'sinclave@ejemplo.test'),
    ).toBe(false);
  });

  it('expires an approval that was not carried out within its window', async () => {
    const id = await approvedRequest({ requesterEmail: 'tarde@ejemplo.test' });
    const eightDaysLater = new Date(clock().getTime() + 8 * 86_400_000);

    const result = await runRelease(id, 0, { clock: () => eightDaysLater });

    expect(result.status).toBe('completed');
    expect((await requestRow(id))?.status).toBe('expired');
    expect(org.email.lastTo('tarde@ejemplo.test')).toBeUndefined();
    expect((await trail(id)).at(-1)?.metadata).toMatchObject({ phase: 'expired' });
  });

  it('leaves alone a request that is not approved (a retried delivery after the end)', async () => {
    const id = await approvedRequest({ requesterEmail: 'dosveces@ejemplo.test' });
    await runRelease(id);
    const sent = org.email.sent.length;

    const again = await runRelease(id);

    expect(again.status).toBe('completed');
    expect(org.email.sent.length).toBe(sent);
  });
});

describe('a link that ends unused', () => {
  it('stops working when it ends, and the sweep takes the package out of the bucket', async () => {
    const id = await approvedRequest({ requesterEmail: 'vence@ejemplo.test' });
    await runRelease(id);
    const token = tokenFrom('vence@ejemplo.test');
    const key = `t/${org.world.tenant.id}/archive-release/${id}.zip`;
    expect((await linkCall('GET', token)).statusCode).toBe(200);
    expect(await org.storage.head(org.world.tenant.id, key)).not.toBeNull();

    // Seventy-two hours pass: the link and the request end together.
    await admin.query(
      "update action_token set expires_at = now() - interval '1 hour' where subject_id = $1 and kind = 'archive_release'",
      [id],
    );
    await admin.query(
      "update archive_release_request set link_expires_at = now() - interval '1 hour' where id = $1",
      [id],
    );
    const late = await linkCall('POST', token);
    const lateLook = await linkCall('GET', token);
    const swept = await sweepReleases({
      db: releaserDb.db,
      withTenant: releaserWithTenant(),
      client: createRecordingJobClient(),
      storage: org.storage,
      clock,
    });

    expect(late.statusCode).toBe(404);
    expect(lateLook.statusCode).toBe(404);
    expect(swept.removed).toBeGreaterThanOrEqual(1);
    expect(await org.storage.head(org.world.tenant.id, key)).toBeNull();
    expect((await requestRow(id))?.package_removed_at).not.toBeNull();
    // Once cleared, the next sweep has nothing more to clear.
    const again = await sweepReleases({
      db: releaserDb.db,
      withTenant: releaserWithTenant(),
      client: createRecordingJobClient(),
      storage: org.storage,
      clock,
    });
    expect(again.removed).toBe(0);
  });
});

describe('a release that goes wrong leaves nothing behind (JD-S6 R1-S6-8)', () => {
  const stored = async (id: string) =>
    (await org.storage.head(
      org.world.tenant.id,
      `t/${org.world.tenant.id}/archive-release/${id}.zip`,
    )) !== null;

  it('sets the row to released before the email, and undoes the release when the email never goes out', async () => {
    const id = await approvedRequest({ requesterEmail: 'sinmail@ejemplo.test' });
    const seen: string[] = [];
    const flaky = {
      ...org.email,
      send: async (message: { to: string }) => {
        // When the email is tried the row already says released, and the package is in the bucket.
        if (message.to === 'sinmail@ejemplo.test') {
          seen.push((await requestRow(id))?.status ?? '');
          seen.push(String(await stored(id)));
          throw new Error('the mail server is down');
        }
      },
    } as unknown as ArchiveReleaseDeps['email'];

    const result = await runRelease(id, 0, { email: flaky });
    const row = await requestRow(id);

    expect(result.status).toBe('completed');
    expect(seen.slice(0, 2)).toEqual(['released', 'true']);
    expect(row).toMatchObject({
      status: 'failed',
      failure_code: 'email_failed',
      package_key: null,
    });
    // No package, no link: nothing that was sent or could be used is left.
    expect(await stored(id)).toBe(false);
    expect(row?.package_removed_at).not.toBeNull();
    expect(row?.link_expires_at).toBeNull();
    expect(org.email.lastTo('sinmail@ejemplo.test')).toBeUndefined();
    expect((await trail(id)).at(-1)?.metadata).toMatchObject({
      phase: 'failed',
      code: 'email_failed',
    });
  });

  it('takes the package out of the bucket when a release fails for good after storing it', async () => {
    const id = await approvedRequest({ requesterEmail: 'fallo@ejemplo.test' });
    const tokens = createActionTokens({ clock });
    const broken = {
      ...tokens,
      issue: () => Promise.reject(new Error('the tokens are not available')),
    } as unknown as ArchiveReleaseDeps['tokens'];

    // First delivery: the package is stored, the queue tries again. Last delivery: the request ends.
    await expect(runRelease(id, 0, { tokens: broken })).rejects.toThrow();
    expect(await stored(id)).toBe(true);
    const last = await runRelease(id, 1, { tokens: broken });

    expect(last.status).toBe('completed');
    expect(await requestRow(id)).toMatchObject({
      status: 'failed',
      failure_code: 'release_failed',
    });
    expect(await stored(id)).toBe(false);
    expect((await requestRow(id))?.package_removed_at).not.toBeNull();
  });

  it('clears the package that a failed or expired release left behind, when the sweep finds it', async () => {
    const id = await approvedRequest({ requesterEmail: 'huerfano@ejemplo.test' });
    const key = `t/${org.world.tenant.id}/archive-release/${id}.zip`;
    // A crash after the upload and before the settlement: the request ended with a package in the bucket.
    await org.storage.put(org.world.tenant.id, key, {
      body: Buffer.from('records'),
      contentType: 'application/zip',
      contentLength: 7,
    });
    await admin.query(
      "update archive_release_request set status = 'failed', failure_code = 'release_failed', updated_at = now() - interval '1 hour' where id = $1",
      [id],
    );

    const swept = await sweepReleases({
      db: releaserDb.db,
      withTenant: releaserWithTenant(),
      client: createRecordingJobClient(),
      storage: org.storage,
      clock,
    });

    expect(swept.removed).toBeGreaterThanOrEqual(1);
    expect(await org.storage.head(org.world.tenant.id, key)).toBeNull();
    expect((await requestRow(id))?.package_removed_at).not.toBeNull();
  });
});

describe('a download that breaks can be tried again (JD-S6 R1-S6-8)', () => {
  const asSystem = () => ({ tenantId: org.world.tenant.id, userId: SYSTEM_USER_ID });
  const tokens = () => createActionTokens({ clock });

  async function releasedRequest(email: string) {
    const id = await approvedRequest({ requesterEmail: email });
    await runRelease(id);
    return { id, token: tokenFrom(email) };
  }

  it('spends the link when the transfer ends and not when it starts, one download at a time', async () => {
    const { id, token } = await releasedRequest('corte@ejemplo.test');
    const run = <T>(work: (tx: Tx) => Promise<T>) => runtimeWithTenant(asSystem(), work);

    const first = await run((tx) => claimDownload(tx, tokens(), token, clock()));
    // A second download while the first is in progress, and a look at the link: the lease holds.
    const second = await run((tx) => claimDownload(tx, tokens(), token, clock()));
    const looking = await linkCall('GET', token);
    // The first one breaks: the lease is given back, the link is not spent.
    await run((tx) => abandonDownload(tx, id));
    const third = await run((tx) => claimDownload(tx, tokens(), token, clock()));

    expect(first).toMatchObject({ id });
    expect(second).toBeNull();
    expect(looking.statusCode).toBe(200);
    expect(third).toMatchObject({ id });
    expect((await requestRow(id))?.downloaded_at).toBeNull();

    // The retry finishes: now the link is spent, the entry is written once, and nobody claims again.
    const done = await run((tx) => completeDownload(tx, tokens(), token, id, clock()));
    const again = await run((tx) => claimDownload(tx, tokens(), token, clock()));
    const entries = (await trail(id)).filter((step) => step.metadata.phase === 'downloaded');
    expect(done).toBe(true);
    expect(again).toBeNull();
    expect((await requestRow(id))?.downloaded_at).not.toBeNull();
    expect(entries).toHaveLength(1);
    expect((await linkCall('GET', token)).statusCode).toBe(404);
  });

  it('bounds the retries: after five attempts the link answers like one that does not work', async () => {
    const { id, token } = await releasedRequest('muchos@ejemplo.test');
    const run = <T>(work: (tx: Tx) => Promise<T>) => runtimeWithTenant(asSystem(), work);

    for (let attempt = 0; attempt < MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
      expect(await run((tx) => claimDownload(tx, tokens(), token, clock()))).not.toBeNull();
      await run((tx) => abandonDownload(tx, id));
    }
    const over = await run((tx) => claimDownload(tx, tokens(), token, clock()));
    const download = await linkCall('POST', token);

    expect(over).toBeNull();
    expect(download.statusCode).toBe(404);
  });

  it('gives the lease back when the package cannot be read, so the link still works', async () => {
    const { id, token } = await releasedRequest('perdido@ejemplo.test');
    const key = `t/${org.world.tenant.id}/archive-release/${id}.zip`;
    await org.storage.remove(org.world.tenant.id, key);

    const download = await linkCall('POST', token);

    expect(download.statusCode).toBe(404);
    const row = await admin.query<{ download_started_at: Date | null; download_attempts: number }>(
      'select download_started_at, download_attempts from archive_release_request where id = $1',
      [id],
    );
    expect(row.rows[0]).toMatchObject({ download_started_at: null, download_attempts: 1 });
  });
});

describe('what a legal erasure removed is answered erased (JD-S6 R1-S6-7)', () => {
  async function setErased(prefixes: string[], whole: boolean) {
    await admin.query(
      'update tenant_archive set erased_prefixes = $2::text[], erased_at = $3 where tenant_id = $1',
      [org.world.tenant.id, prefixes, whole ? new Date() : null],
    );
  }
  const restore = () =>
    admin.query(
      "update tenant_archive set erased_prefixes = '{}', erased_at = null where tenant_id = $1",
      [org.world.tenant.id],
    );

  it('fails a release of an archive that was erased, with the code erased, and sends nothing', async () => {
    const id = await approvedRequest({ requesterEmail: 'borrado@ejemplo.test' });
    await setErased([`tenants/${org.world.tenant.id}/`], true);
    try {
      await runRelease(id);
    } finally {
      await restore();
    }

    expect(await requestRow(id)).toMatchObject({ status: 'failed', failure_code: 'erased' });
    expect(org.email.lastTo('borrado@ejemplo.test')).toBeUndefined();
  });

  it('answers erased for the part of a professional that was erased, and for a patient whose records span it', async () => {
    const archive = await admin.query<{ manifest_key: string }>(
      'select manifest_key from tenant_archive where tenant_id = $1',
      [org.world.tenant.id],
    );
    const raw = await store.get(archive.rows[0]?.manifest_key ?? '');
    if (raw.status !== 'found') throw new Error('the manifest is not there');
    const manifest = parseManifest(raw.body);
    const clinical = manifest.parts.filter((part) => part.kind === 'clinical');
    const ofA = clinical.find((part) => part.professional?.matricula === matriculaOfA.number);
    const erasedName = ofA?.objects[0]?.name ?? '';
    expect(erasedName).not.toBe('');

    const professional = await approvedRequest({
      requesterKind: 'professional',
      requesterName: 'Dra. Prueba',
      requesterEmail: 'borrada@ejemplo.test',
      documentType: undefined,
      document: undefined,
      matriculaJurisdiction: matriculaOfA.jurisdiction,
      matricula: matriculaOfA.number,
      reason: 'Continuidad de la atención de mis pacientes',
    });
    const patient = await approvedRequest({ requesterEmail: 'borrada.paciente@ejemplo.test' });
    await setErased([erasedName], false);
    try {
      await runRelease(professional);
      await runRelease(patient);
    } finally {
      await restore();
    }

    expect(await requestRow(professional)).toMatchObject({
      status: 'failed',
      failure_code: 'erased',
    });
    // A patient's records span every part: one erased is a gap, so the answer is the same.
    expect(await requestRow(patient)).toMatchObject({ status: 'failed', failure_code: 'erased' });
  });
});
