import type {
  CreatePatientResponse,
  DownloadLinkResponse,
  ExportPackageResponse,
  OperatorCancelTenantResponse,
  Problem,
} from '@consultorio/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { exportPackage } from '../../src/db/schema/export-package.js';
import { platformAuditEvent } from '../../src/db/schema/operator.js';
import { tenant } from '../../src/db/schema/tenant.js';
import { CANCELLATION_EXPORT_JOB, createExportRegistry } from '../../src/modules/tenancy/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import { createClinicalWorld, type Professional } from '../support/clinical-world.js';
import {
  EXPORT_NOW,
  createRetentionWorld,
  type RetentionWorld,
} from '../support/retention-world.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';
import { allTextOf, readZip } from '../support/zip-reader.js';

/**
 * The cancellation export (tenancy, "Tenant cancellation export"): an administrative package for the
 * owner and one clinical package per professional, built by a job after the organization is
 * cancelled. These tests go through the real application, the real database (as `app_rw` and as the
 * operator role) and the real contributors of every module.
 */

let runtime: DbHandle;
let org: RetentionWorld;
let doctorA: Professional;
let doctorB: Professional;
let departed: Professional;
let owner: TestSession;

/** Phrases that only exist in clinical content: they must reach the right professional and no one else. */
const NOTE_A = 'Dolor lumbar de Ana, control A';
const NOTE_B = 'Cefalea de Bruno, control B';
const NOTE_BOTH_A = 'Hipertensión compartida, visto por A';
const NOTE_BOTH_B = 'Hipertensión compartida, visto por B';
const NOTE_DEPARTED = 'Registro de quien ya no está';
const ANAMNESIS_A = 'Antecedente asmático de la paciente de A';
const OTHER_ORG = 'ClinicaAjena';

const entry = (text: string) => ({ reasonForConsultation: text });

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  org = await createRetentionWorld(runtime, 'cancel-export');
  const { world } = org;
  owner = world.owner;

  doctorA = await world.professional();
  doctorB = await world.professional();
  departed = await world.professional();

  const patientA = await world.patient([doctorA]);
  const patientB = await world.patient([doctorB]);
  const patientBoth = await world.patient([doctorA, doctorB]);
  const patientOrphan = await world.patient([departed]);

  await org.signedEntry(doctorA, patientA, entry(NOTE_A));
  await org.signedEntry(doctorB, patientB, entry(NOTE_B));
  await org.signedEntry(doctorA, patientBoth, entry(NOTE_BOTH_A));
  await org.signedEntry(doctorB, patientBoth, entry(NOTE_BOTH_B));
  await org.signedEntry(departed, patientOrphan, entry(NOTE_DEPARTED));
  const saved = await world.api.put(`/patients/${patientA}/anamnesis`, doctorA.session, {
    content: {
      allergies: [],
      medications: [],
      conditions: [],
      antecedents: ANAMNESIS_A,
      indicators: { pregnant: false, implantedDevice: false, anticoagulated: false },
    },
    expectedVersion: 0,
  });
  expect(saved.statusCode, saved.body).toBe(200);

  // Another organization with a patient and an entry of its own: none of it may be in ours.
  const other = await createClinicalWorld(runtime, 'cancel-export-other');
  const outsider = await other.professional();
  const outsiderPatient = await other.api.post('/patients', other.reception, {
    familyName: OTHER_ORG,
    givenNames: 'Paciente',
    birthDate: '1975-02-02',
    dataProcessingConsent: true,
  });
  await other.open(outsider, outsiderPatient.json<CreatePatientResponse>().patient.id);
  await other.close();

  // A professional who left before the organization ended.
  const left = await world.api.post(
    `/staff/${departed.session.user.membershipId}/deactivate`,
    world.owner,
  );
  expect(left.statusCode, left.body).toBe(200);

  const cancelled = await org.cancel();
  expect(cancelled.statusCode, cancelled.body).toBe(200);
  await org.buildPackages();
});

afterAll(async () => {
  await org.close();
  await runtime.close();
});

const packagesOf = () =>
  asTenant(runtime, org.world.tenant.id, (tx) =>
    tx.select().from(exportPackage).orderBy(asc(exportPackage.kind), asc(exportPackage.createdAt)),
  );

/** Asks for the link and follows it: the bytes of the package, or the status that stopped it. */
async function download(
  session: TestSession,
  kind: 'administrative' | 'clinical',
): Promise<{ status: number; bytes: Buffer; headers: Record<string, unknown> }> {
  const link = await org.world.api.post(`/cancellation/export/${kind}/download`, session);
  if (link.statusCode !== 200)
    return { status: link.statusCode, bytes: Buffer.alloc(0), headers: {} };
  const file = await org.world.api.get(link.json<DownloadLinkResponse>().url, session);
  return { status: file.statusCode, bytes: file.rawPayload, headers: file.headers };
}

async function zipOf(session: TestSession, kind: 'administrative' | 'clinical') {
  const file = await download(session, kind);
  expect(file.status).toBe(200);
  return readZip(file.bytes);
}

describe('the operator cancels an organization', () => {
  it('ends it, announces it in the same transaction and leaves both trails', async () => {
    const state = await asTenant(runtime, org.world.tenant.id, (tx) =>
      tx.select({ status: tenant.status }).from(tenant),
    );
    const tenantTrail = await asTenant(runtime, org.world.tenant.id, (tx) =>
      tx
        .select({
          action: auditEvent.action,
          actor: auditEvent.actorUserId,
          metadata: auditEvent.metadata,
        })
        .from(auditEvent)
        .where(sql`${auditEvent.action} in ('tenant.cancelled', 'export.cancellation.requested')`)
        .orderBy(asc(auditEvent.occurredAt)),
    );
    const platformTrail = await org.operator.harness.db.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${org.world.tenant.id}, true)`);
      return tx
        .select({ action: platformAuditEvent.action, operator: platformAuditEvent.operatorId })
        .from(platformAuditEvent)
        .where(
          and(
            eq(platformAuditEvent.targetTenantId, org.world.tenant.id),
            eq(platformAuditEvent.action, 'tenant.cancelled'),
          ),
        );
    });

    expect(state).toEqual([{ status: 'cancelled' }]);
    expect(tenantTrail.map((event) => event.action)).toEqual([
      'tenant.cancelled',
      'export.cancellation.requested',
    ]);
    expect(tenantTrail[0]?.actor).toBe(org.operator.id);
    expect(tenantTrail[1]?.metadata).toMatchObject({ kind: 'administrative', source: 'operator' });
    expect(platformTrail).toEqual([{ action: 'tenant.cancelled', operator: org.operator.id }]);
  });

  it('answers the cancellation of an organization that is already cancelled with a conflict, and changes nothing', async () => {
    const again = await org.cancel();
    const rows = await packagesOf();

    expect(again.statusCode).toBe(409);
    expect(rows.filter((row) => row.kind === 'administrative')).toHaveLength(1);
  });

  it('refuses a demo organization and one that does not exist', async () => {
    const demo = await createTestTenant(runtime, { slug: 'cancel-export-demo', isDemo: true });

    const refusedDemo = await org.cancel(demo.id);
    const unknown = await org.cancel('0190a000-0000-7000-8000-00000000dead');

    expect(refusedDemo.statusCode).toBe(409);
    expect(unknown.statusCode).toBe(404);
    const [state] = await asTenant(runtime, demo.id, (tx) =>
      tx.select({ status: tenant.status }).from(tenant),
    );
    expect(state?.status).toBe('active');
  });

  it('wants a reason, which goes to the platform trail with the operator (JD-S6 R1-S6-2)', async () => {
    const reasoned = await createTestTenant(runtime, { slug: 'cancel-export-reason' });

    const without = await org.cancel(reasoned.id, null);
    const empty = await org.cancel(reasoned.id, { reason: '  ' });
    const [untouched] = await asTenant(runtime, reasoned.id, (tx) =>
      tx.select({ status: tenant.status }).from(tenant),
    );
    const done = await org.cancel(reasoned.id, {
      reason: 'Cierre pedido por la titular, ticket 4471',
    });

    expect(without.statusCode).toBe(400);
    expect(empty.statusCode).toBe(400);
    expect(untouched?.status).toBe('active');
    expect(done.statusCode, done.body).toBe(200);
    const admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    try {
      const trail = await admin.query<{ reason: string | null; operator_id: string | null }>(
        "select reason, operator_id from platform_audit_event where action = 'tenant.cancelled' and target_tenant_id = $1",
        [reasoned.id],
      );
      expect(trail.rows).toEqual([
        { reason: 'Cierre pedido por la titular, ticket 4471', operator_id: org.operator.id },
      ]);
    } finally {
      await admin.end();
    }
  });

  it('refuses an organization that has a subscription: its end goes through the subscription, not through this route (JD-S6 R1-S6-2)', async () => {
    const billed = await createTestTenant(runtime, { slug: 'cancel-export-billed' });
    const admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    try {
      await admin.query(
        `insert into subscription (tenant_id, plan_id, status, trial_ends_at, overage_cap_messages)
         select $1, id, 'trial', now() + interval '14 days', 300 from plan where key = 'standard'`,
        [billed.id],
      );
      const refused = await org.cancel(billed.id);
      const again = await org.cancel(billed.id);
      const trail = await admin.query(
        "select 1 from platform_audit_event where action = 'tenant.cancelled' and target_tenant_id = $1",
        [billed.id],
      );
      const requested = await asTenant(runtime, billed.id, (tx) => tx.select().from(exportPackage));
      const [state] = await asTenant(runtime, billed.id, (tx) =>
        tx.select({ status: tenant.status }).from(tenant),
      );

      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json<{ code: string }>().code).toBe('operator_cancel_has_subscription');
      expect(again.statusCode).toBe(409);
      // Nothing happened: the organization is active, nothing was asked for, nothing was written.
      expect(state?.status).toBe('active');
      expect(requested).toHaveLength(0);
      expect(trail.rowCount).toBe(0);
    } finally {
      await admin.end();
    }
  });

  it('needs the operator session: a staff session, or none, is turned away', async () => {
    const withoutSession = await org.world.app.inject({
      method: 'POST',
      url: `/operator/tenants/${org.world.tenant.id}/cancel`,
      headers: { host: 'platform.consultorio.test', origin: 'https://platform.consultorio.test' },
    });
    const asStaff = await org.world.api.post(
      `/operator/tenants/${org.world.tenant.id}/cancel`,
      owner,
    );

    expect(withoutSession.statusCode).toBe(401);
    // A staff host does not serve the console: the route is not there (or the organization, already
    // cancelled in this file, refuses the write first). Either way it is not served.
    expect([402, 404]).toContain(asStaff.statusCode);
  });

  it('asks for the export of any organization it cancels and answers with the state alone', async () => {
    const plain = await createTestTenant(runtime, { slug: 'cancel-export-plain' });

    const response = await org.cancel(plain.id);

    expect(response.statusCode, response.body).toBe(200);
    // One field: the operator is told that the organization ended, never what its export holds.
    expect(response.json<OperatorCancelTenantResponse>()).toEqual({ status: 'cancelled' });
    const requested = await asTenant(runtime, plain.id, (tx) => tx.select().from(exportPackage));
    expect(requested.map((row) => `${row.kind}:${row.status}`)).toEqual(['administrative:queued']);
  });
});

describe('the packages that were made', () => {
  it('makes one administrative package and one clinical package per professional who is still there', async () => {
    const rows = await packagesOf();

    expect(
      rows.map((row) => `${row.kind}:${row.status}`),
      JSON.stringify(rows.map((row) => row.failureCode)),
    ).toEqual(['administrative:ready', 'clinical:ready', 'clinical:ready']);
    expect(
      rows
        .filter((row) => row.kind === 'clinical')
        .map((row) => row.professionalId)
        .sort(),
    ).toEqual([doctorA.professionalId, doctorB.professionalId].sort());
    for (const row of rows) {
      expect(row.objectKey).toMatch(
        new RegExp(`^t/${org.world.tenant.id}/cancellation-export/${row.id}\\.zip$`),
      );
      expect(row.fileName).toMatch(/^exportacion-(administrativa|clinica)-20310531\.zip$/);
      expect(row.sizeBytes).toBeGreaterThan(0);
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // The stored bytes are the ones the row describes.
    const [first] = rows;
    const stored = await org.storage.get(org.world.tenant.id, first?.objectKey ?? '');
    expect(stored?.size).toBe(first?.sizeBytes);
  });

  it('puts the administrative package together from the modules, with a summary, and no clinical content', async () => {
    const files = await zipOf(owner, 'administrative');
    const names = [...files.keys()];
    const text = allTextOf(files);

    expect(names).toEqual(expect.arrayContaining(['manifiesto.json', 'resumen.pdf']));
    expect(names).toEqual(
      expect.arrayContaining([
        'tenancy/organization.json',
        'patients/patients.json',
        'identity/staff.json',
        'scheduling/appointments.json',
        'audit/auditEvents.json',
      ]),
    );
    // Nothing clinical reaches the owner: no entry, no anamnesis, and not one phrase of them.
    for (const phrase of [NOTE_A, NOTE_B, NOTE_BOTH_A, NOTE_BOTH_B, NOTE_DEPARTED, ANAMNESIS_A]) {
      expect(text, phrase).not.toContain(phrase);
    }
    expect(
      names.filter((name) => /^(clinical|prescriptions)\/|anamnesis|addenda|consents/i.test(name)),
    ).toEqual([]);
    expect(text).toContain('Clinica'); // the demographics of the patients are there
    const manifest = JSON.parse(files.get('manifiesto.json')?.toString('utf8') ?? '') as {
      kind: string;
      generatedAt: string;
      sections: { rows: number | null; contributor: string }[];
      redactedFields: string[];
    };
    expect(manifest.kind).toBe('administrative');
    expect(manifest.generatedAt).toBe(EXPORT_NOW.toISOString());
    expect(files.get('resumen.pdf')?.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('holds no secret: no password hash, token hash, key or authenticator secret in any package', async () => {
    const texts = [
      allTextOf(await zipOf(owner, 'administrative')),
      allTextOf(await zipOf(doctorA.session, 'clinical')),
    ];

    for (const text of texts) {
      expect(text).not.toMatch(/argon2/i);
      expect(text).not.toMatch(
        /"(passwordHash|password_hash|tokenHash|token_hash|totp\w*|secret\w*)"/i,
      );
    }
    // Defence in depth did not have to act: the contributors of the modules are clean.
    const manifest = JSON.parse(
      (await zipOf(owner, 'administrative')).get('manifiesto.json')?.toString('utf8') ?? '{}',
    ) as { redactedFields: string[] };
    expect(manifest.redactedFields).toEqual([]);
  });

  it("gives each professional their own patients and nobody else's, a shared patient appearing in both", async () => {
    const a = allTextOf(await zipOf(doctorA.session, 'clinical'));
    const b = allTextOf(await zipOf(doctorB.session, 'clinical'));

    expect(a).toContain(NOTE_A);
    expect(a).toContain(NOTE_BOTH_A);
    expect(a).toContain(ANAMNESIS_A);
    expect(a).not.toContain(NOTE_B);
    expect(b).toContain(NOTE_B);
    expect(b).toContain(NOTE_BOTH_B);
    expect(b).not.toContain(NOTE_A);
    expect(b).not.toContain(ANAMNESIS_A);
    // The patient seen by both is in both packages, each with the entries that professional can read.
    expect(a).toContain(NOTE_BOTH_B);
    expect(b).toContain(NOTE_BOTH_A);
  });

  it('keeps the records of a professional who left out of every package: they wait for the archive custody', async () => {
    const everything = [
      allTextOf(await zipOf(owner, 'administrative')),
      allTextOf(await zipOf(doctorA.session, 'clinical')),
      allTextOf(await zipOf(doctorB.session, 'clinical')),
    ].join('\n');

    expect(everything).not.toContain(NOTE_DEPARTED);
    const departedPackages = (await packagesOf()).filter(
      (row) => row.professionalId === departed.professionalId,
    );
    expect(departedPackages).toEqual([]);
    // The entry itself is still in the database: nothing was deleted.
    const admin = new pg.Client({ connectionString: inject('adminUrl') });
    await admin.connect();
    try {
      const stillThere = await admin.query<{ n: number }>(
        'select count(*)::int as n from clinical_note where tenant_id = $1',
        [org.world.tenant.id],
      );
      expect(stillThere.rows[0]?.n).toBe(5);
    } finally {
      await admin.end();
    }
  });

  it('holds nothing of another organization', async () => {
    const all = [
      allTextOf(await zipOf(owner, 'administrative')),
      allTextOf(await zipOf(doctorA.session, 'clinical')),
      allTextOf(await zipOf(doctorB.session, 'clinical')),
    ].join('\n');

    expect(all).not.toContain(OTHER_ORG);
    expect(all).not.toContain('cancel-export-other');
  });

  it('makes no second package and writes no second request when the job runs again', async () => {
    const before = await packagesOf();
    await org.buildPackages();
    const after = await packagesOf();

    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.map((row) => row.sha256)).toEqual(before.map((row) => row.sha256));
  });

  it('tells the owner and each professional, without a patient, a record or a link to the file', () => {
    const sent = org.email.sent.filter((message) => /exportación/i.test(message.subject));
    const recipients = sent.map((message) => message.to).sort();

    expect(recipients).toEqual(
      [owner.user.email, doctorA.session.user.email, doctorB.session.user.email].sort(),
    );
    for (const message of sent) {
      expect(message.text).not.toContain(NOTE_A);
      expect(message.text).not.toContain('Clinica');
      expect(message.text).not.toContain('/files/');
      expect(message.text).toContain('https://cancel-export.consultorio.test/export');
    }
    const clinical = sent.find((message) => message.to === doctorA.session.user.email);
    expect(clinical?.text).toContain('/export/clinical');
    expect(sent.find((message) => message.to === owner.user.email)?.text).not.toContain(
      '/export/clinical',
    );
  });
});

describe('who may have which package', () => {
  it('shows each one the state of their own package', async () => {
    const administrative = await org.world.api.get('/cancellation/export/administrative', owner);
    const clinical = await org.world.api.get('/cancellation/export/clinical', doctorA.session);

    expect(administrative.statusCode).toBe(200);
    expect(administrative.json<ExportPackageResponse>().package).toMatchObject({
      kind: 'administrative',
      status: 'ready',
    });
    expect(clinical.json<ExportPackageResponse>().package).toMatchObject({
      kind: 'clinical',
      status: 'ready',
    });
    // The state carries no key and no storage address.
    expect(administrative.body).not.toMatch(/objectKey|cancellation-export\//);
  });

  it('gives an owner who is not a professional nothing clinical', async () => {
    const state = await org.world.api.get('/cancellation/export/clinical', owner);
    const link = await org.world.api.post('/cancellation/export/clinical/download', owner);

    expect(state.statusCode).toBe(403);
    expect(link.statusCode).toBe(403);
  });

  it('gives an administrator, who is not the owner, neither package', async () => {
    const admin = org.world.admin;

    expect((await org.world.api.get('/cancellation/export/administrative', admin)).statusCode).toBe(
      403,
    );
    expect(
      (await org.world.api.post('/cancellation/export/administrative/download', admin)).statusCode,
    ).toBe(403);
    expect((await org.world.api.get('/cancellation/export/clinical', admin)).statusCode).toBe(403);
  });

  it('gives a professional the clinical package and not the administrative one', async () => {
    expect(
      (await org.world.api.get('/cancellation/export/administrative', doctorA.session)).statusCode,
    ).toBe(403);
    expect(
      (await org.world.api.post('/cancellation/export/administrative/download', doctorA.session))
        .statusCode,
    ).toBe(403);
    expect(
      (await org.world.api.post('/cancellation/export/clinical/download', doctorA.session))
        .statusCode,
    ).toBe(200);
  });

  it('gives reception nothing', async () => {
    const reception = org.world.reception;

    expect(
      (await org.world.api.get('/cancellation/export/administrative', reception)).statusCode,
    ).toBe(403);
    expect((await org.world.api.get('/cancellation/export/clinical', reception)).statusCode).toBe(
      403,
    );
  });

  it('lets a link be used once, by the session it was issued to', async () => {
    const link = (
      await org.world.api.post('/cancellation/export/clinical/download', doctorA.session)
    ).json<DownloadLinkResponse>();

    const colleague = await org.world.api.get(link.url, doctorB.session);
    const first = await org.world.api.get(link.url, doctorA.session);
    const second = await org.world.api.get(link.url, doctorA.session);

    // Another session cannot use it (and does not spend it); the right one uses it once.
    expect(colleague.statusCode).toBe(403);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(403);
    expect(first.headers['content-type']).toBe('application/zip');
    expect(first.headers['content-disposition']).toMatch(
      /^attachment; filename="exportacion-clinica-20310531\.zip"$/,
    );
    expect(first.headers['cache-control']).toBe('no-store');
  });

  it("writes who asked for each package and who downloaded it, in the organization's own trail", async () => {
    const trail = await asTenant(runtime, org.world.tenant.id, (tx) =>
      tx
        .select({
          action: auditEvent.action,
          actor: auditEvent.actorUserId,
          metadata: auditEvent.metadata,
        })
        .from(auditEvent)
        .where(
          sql`${auditEvent.action} in ('export.cancellation.requested', 'export.cancellation.downloaded')`,
        )
        .orderBy(asc(auditEvent.occurredAt)),
    );

    const downloads = trail.filter((event) => event.action === 'export.cancellation.downloaded');
    const requests = trail.filter(
      (event) => event.action === 'export.cancellation.requested' && event.actor !== null,
    );
    expect(downloads.length).toBeGreaterThanOrEqual(3);
    expect(downloads.map((event) => event.actor)).toEqual(
      expect.arrayContaining([owner.user.id, doctorA.session.user.id, doctorB.session.user.id]),
    );
    expect(
      downloads.every((event) =>
        ['administrative', 'clinical'].includes(String(event.metadata['kind'])),
      ),
    ).toBe(true);
    expect(requests.map((event) => event.metadata['origin'])).toContain('download');
    // The entries name the package and the person, never what is in it.
    expect(JSON.stringify(trail)).not.toContain(NOTE_A);
  });
});

describe('the identity data that leaves in bulk', () => {
  const bulkReads = () =>
    asTenant(runtime, org.world.tenant.id, (tx) =>
      tx
        .select({
          actor: auditEvent.actorUserId,
          resourceType: auditEvent.resourceType,
          resourceId: auditEvent.resourceId,
          metadata: auditEvent.metadata,
        })
        .from(auditEvent)
        .where(sql`${auditEvent.action} = 'patient.bulk_read'`)
        .orderBy(asc(auditEvent.occurredAt)),
    );

  it('is written once, for the administrative package, with how many patients it carries and no name', async () => {
    const reads = await bulkReads();
    const packages = await packagesOf();
    const administrative = packages.find((row) => row.kind === 'administrative');

    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      actor: null,
      resourceType: 'export_package',
      resourceId: administrative?.id,
      metadata: { kind: 'administrative', patients: 4 },
    });
    // Counts and the id of the package, never a name or a document number.
    expect(JSON.stringify(reads)).not.toMatch(/Clinica|Paciente|dni/i);
  });

  it('is not written for a clinical package, whose patients are read as clinical records', async () => {
    const reads = await bulkReads();
    const packages = await packagesOf();
    const clinicalIds = packages.filter((row) => row.kind === 'clinical').map((row) => row.id);

    expect(clinicalIds.length).toBeGreaterThanOrEqual(2);
    expect(reads.filter((read) => clinicalIds.includes(read.resourceId ?? ''))).toEqual([]);
  });
});

describe('a package that cannot be made', () => {
  it('answers the link of a package that is not ready yet with a conflict, and issues nothing', async () => {
    const world = await createClinicalWorld(runtime, 'cancel-export-waiting');
    try {
      await asTenant(runtime, world.tenant.id, (tx) =>
        tx.execute(
          sql`insert into export_package (tenant_id, kind, status) values (${world.tenant.id}, 'administrative', 'queued')`,
        ),
      );

      const link = await world.api.post(
        '/cancellation/export/administrative/download',
        world.owner,
      );
      const state = await world.api.get('/cancellation/export/administrative', world.owner);

      expect(link.statusCode).toBe(409);
      expect(link.json<Problem>().code).toBe('export_package_not_ready');
      expect(state.json<ExportPackageResponse>().package).toMatchObject({
        status: 'queued',
        fileName: null,
        sizeBytes: null,
      });
    } finally {
      await world.close();
    }
  });

  it('fails closed when a contributor of the administrative part emits a clinical field: nothing is stored', async () => {
    const world = await createClinicalWorld(runtime, 'cancel-export-leak');
    const leak = createExportRegistry();
    leak.registerExportContributor('administrative', 'leaky', () =>
      Promise.resolve({ patients: [{ id: 'p1', visit: { content: 'dato clínico' } }] }),
    );
    try {
      await asTenant(runtime, world.tenant.id, (tx) =>
        tx.execute(
          sql`insert into export_package (tenant_id, kind, status) values (${world.tenant.id}, 'administrative', 'queued')`,
        ),
      );
      const storage = org.storage;
      const before = storage.keys().length;

      const result = await runJob(runtime.db, org.job({ exports: leak }), {
        id: '0190a000-0000-7000-8000-00000000b001',
        name: CANCELLATION_EXPORT_JOB,
        data: { tenantId: world.tenant.id, reason: 'cancellation' },
        enqueuedAt: EXPORT_NOW,
        retryCount: 0,
      });

      const [row] = await asTenant(runtime, world.tenant.id, (tx) =>
        tx.select().from(exportPackage),
      );
      expect(result.status).toBe('completed');
      expect(row).toMatchObject({
        status: 'failed',
        failureCode: 'clinical_key_in_administrative_part',
        objectKey: null,
      });
      expect(storage.keys().length).toBe(before);
    } finally {
      await world.close();
    }
  });

  it('is tried again after a failure and gives up with a code on the last delivery', async () => {
    const world = await createClinicalWorld(runtime, 'cancel-export-retry');
    const flaky = createExportRegistry();
    flaky.registerExportContributor('administrative', 'flaky', () =>
      Promise.reject(new Error('database went away')),
    );
    try {
      await asTenant(runtime, world.tenant.id, (tx) =>
        tx.execute(
          sql`insert into export_package (tenant_id, kind, status) values (${world.tenant.id}, 'administrative', 'queued')`,
        ),
      );
      const run = (retryCount: number, id: string) =>
        runJob(runtime.db, org.job({ exports: flaky }), {
          id,
          name: CANCELLATION_EXPORT_JOB,
          data: { tenantId: world.tenant.id, reason: 'cancellation' },
          enqueuedAt: EXPORT_NOW,
          retryCount,
        });

      await expect(run(0, '0190a000-0000-7000-8000-00000000b002')).rejects.toThrow(
        'database went away',
      );
      const [waiting] = await asTenant(runtime, world.tenant.id, (tx) =>
        tx.select().from(exportPackage),
      );
      expect(waiting?.status).toBe('queued');

      await run(2, '0190a000-0000-7000-8000-00000000b003');
      const [given] = await asTenant(runtime, world.tenant.id, (tx) =>
        tx.select().from(exportPackage),
      );
      expect(given).toMatchObject({ status: 'failed', failureCode: 'build_failed' });
    } finally {
      await world.close();
    }
  });
});

describe('a solo professional', () => {
  it('receives both packages, the clinical one with all their patients', async () => {
    const solo = await createRetentionWorld(runtime, 'cancel-export-solo', {
      storage: org.storage,
    });
    try {
      const user = await createTestUser(runtime, solo.world.tenant.id, {
        roles: ['owner', 'professional'],
        password: TEST_PASSWORD,
      });
      const session = await signInAs(solo.world.app, 'cancel-export-solo', user);
      const profile = await solo.world.api.put(
        `/staff/${user.membershipId}/professional-profile`,
        session,
        {
          fullName: 'Dra. Titular',
          specialties: ['Medicina general'],
          matricula: { jurisdiction: 'AR-B', number: '811811' },
        },
      );
      expect(profile.statusCode, profile.body).toBe(200);
      const me: Professional = { session, professionalId: profile.json<{ id: string }>().id };
      const first = await solo.world.patient([me]);
      const second = await solo.world.patient([me]);
      await solo.signedEntry(me, first, entry('Primer paciente del consultorio individual'));
      await solo.signedEntry(me, second, entry('Segundo paciente del consultorio individual'));

      expect((await solo.cancel()).statusCode).toBe(200);
      await solo.buildPackages();
      const api = clientFor(solo.world.app, 'cancel-export-solo');
      const link = await api.post('/cancellation/export/clinical/download', session);
      const file = await api.get(link.json<DownloadLinkResponse>().url, session);
      const text = allTextOf(readZip(file.rawPayload));
      const adminLink = await api.post('/cancellation/export/administrative/download', session);

      expect(file.statusCode).toBe(200);
      expect(text).toContain('Primer paciente del consultorio individual');
      expect(text).toContain('Segundo paciente del consultorio individual');
      expect(adminLink.statusCode).toBe(200);
    } finally {
      await solo.close();
    }
  });
});
