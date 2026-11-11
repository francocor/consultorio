import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFakeScanner } from '../../src/adapters/fake-scanner/index.js';
import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { createMemoryObjectStorage } from '../../src/adapters/memory-storage/index.js';
import { ensureDemoTenant, seedDemoTenant } from '../../src/db/seed/demo/index.js';
import { seedPlatformCatalogs } from '../../src/db/seed/platform.js';
import { registerAllExportContributors } from '../../src/main/export-contributors.js';
import { createPasswordHasher } from '../../src/modules/identity/infrastructure/argon2.js';
import { writePackageFile } from '../../src/modules/tenancy/cancellation/package-file.js';
import {
  createExportRegistry,
  type ExportKind,
  type ExportRegistry,
} from '../../src/modules/tenancy/index.js';
import { createTenantKeys, type TenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createOwnerDb, createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  SYSTEM_USER_ID,
  createWithTenant,
  type RequestContext,
  type WithTenant,
} from '../../src/platform/db/tenant-context.js';
import { readZip } from '../support/zip-reader.js';

/**
 * The export reads the big tables a page at a time (tasks 6.33 and 6.35, "Streaming exports"). The
 * demonstration organization has a little of everything, so these checks go through the real
 * contributors of every module:
 *
 * - the sections that can grow with the years of an organization are async iterables, which the
 *   exporter writes row by row (an array has already loaded the table);
 * - the pages lose and repeat nothing: with a page of seven rows the package is byte for byte the
 *   one made with a single page, and every section has as many rows as its table has;
 * - what is still an array is bounded by the size of the organization and is written down.
 */

let runtime: DbHandle;
let admin: pg.Client;
let keys: TenantKeys;
let registry: ExportRegistry;
let withTenant: WithTenant;
let tenantId: string;
let workDir: string;
let storage: ReturnType<typeof createMemoryObjectStorage>;
let cardiologist: { professionalId: string; userId: string };

const CLINICAL_CONTEXT = (): RequestContext => ({
  tenantId,
  userId: cardiologist.userId,
  actingProfessionalId: cardiologist.professionalId,
});
const ADMINISTRATIVE_CONTEXT = (): RequestContext => ({ tenantId, userId: SYSTEM_USER_ID });

/** Sections that grow with the years of an organization: each must come as an async iterable. */
const STREAMED: Record<ExportKind, [contributor: string, section: string][]> = {
  administrative: [
    ['audit', 'auditEvents'],
    ['notifications', 'channelPreferences'],
    ['notifications', 'messages'],
    ['notifications', 'whatsappUsage'],
    ['scheduling', 'appointments'],
    ['scheduling', 'appointmentEvents'],
    ['patients', 'patients'],
    ['billing', 'charges'],
    ['billing', 'chargeLines'],
    ['billing', 'payments'],
    ['billing', 'paymentReversals'],
    ['invoicing', 'invoices'],
    ['invoicing', 'invoiceLines'],
    ['invoicing', 'invoiceDocuments'],
    ['consent', 'requests'],
    ['teleconsultation', 'videoSessions'],
    ['waitlist', 'entries'],
    ['waitlist', 'offers'],
    ['portal', 'identities'],
    ['portal', 'links'],
    ['portal', 'sessions'],
    ['portal', 'documentShares'],
    ['documents', 'documents'],
  ],
  clinical: [
    ['clinical', 'entries'],
    ['patients', 'anamnesis'],
    ['prescriptions', 'prescriptions'],
    ['consent', 'consents'],
    ['documents', 'documents'],
  ],
};

/** The table each streamed section is, for counting its rows with a query that sees everything. */
const ROWS_OF: Record<string, string> = {
  'audit/auditEvents': 'select count(*)::int as n from audit_event where tenant_id = $1',
  'notifications/channelPreferences':
    'select count(*)::int as n from channel_preference where tenant_id = $1',
  'notifications/messages': 'select count(*)::int as n from message where tenant_id = $1',
  'notifications/whatsappUsage':
    'select count(*)::int as n from whatsapp_usage_event where tenant_id = $1',
  'scheduling/appointments': 'select count(*)::int as n from appointment where tenant_id = $1',
  'scheduling/appointmentEvents':
    'select count(*)::int as n from appointment_event where tenant_id = $1',
  'patients/patients': 'select count(*)::int as n from patient where tenant_id = $1',
  'billing/charges': 'select count(*)::int as n from charge where tenant_id = $1',
  'billing/chargeLines': 'select count(*)::int as n from charge_line where tenant_id = $1',
  'billing/payments': 'select count(*)::int as n from payment where tenant_id = $1',
  'billing/paymentReversals':
    'select count(*)::int as n from payment_reversal where tenant_id = $1',
  'invoicing/invoices': 'select count(*)::int as n from invoice where tenant_id = $1',
  'invoicing/invoiceLines': 'select count(*)::int as n from invoice_line where tenant_id = $1',
  'invoicing/invoiceDocuments':
    'select count(*)::int as n from invoice_document where tenant_id = $1',
  'consent/requests': 'select count(*)::int as n from consent_request where tenant_id = $1',
  'teleconsultation/videoSessions':
    'select count(*)::int as n from video_session where tenant_id = $1',
  'waitlist/entries': 'select count(*)::int as n from waitlist_entry where tenant_id = $1',
  'waitlist/offers': 'select count(*)::int as n from waitlist_offer where tenant_id = $1',
  'portal/identities': 'select count(*)::int as n from portal_identity where tenant_id = $1',
  'portal/links': 'select count(*)::int as n from portal_link where tenant_id = $1',
  'portal/sessions': 'select count(*)::int as n from portal_session where tenant_id = $1',
  'portal/documentShares': 'select count(*)::int as n from document_share where tenant_id = $1',
  'documents/documents': `select count(*)::int as n from document
     where tenant_id = $1 and upload_completed_at is not null and abandoned_at is null
       and classification = 'administrative'`,
};

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  const ownerDb = createOwnerDb(inject('ownerUrl'));
  await seedPlatformCatalogs(ownerDb.db);
  await ownerDb.close();
  workDir = await mkdtemp(join(tmpdir(), 'export-streaming-'));

  keys = createTenantKeys({ kms: createLocalKeyManagement(randomBytes(32).toString('base64')) });
  storage = createMemoryObjectStorage();
  withTenant = createWithTenant(runtime.db);
  const tenant = await ensureDemoTenant(runtime.db, withTenant, 'streaming');
  tenantId = tenant.id;
  await seedDemoTenant(
    {
      withTenant,
      hasher: createPasswordHasher(),
      keys,
      consentText: { textKey: 'consent.data_processing', version: '1' },
      clock: () => new Date('2026-03-02T12:00:00Z'),
      documents: { storage, scanner: createFakeScanner() },
    },
    tenantId,
  );
  registry = createExportRegistry();
  registerAllExportContributors(registry, { keys });

  const found = await admin.query<{ professional_id: string; user_id: string }>(
    `select p.id as professional_id, m.user_id
       from professional p
       join membership m on m.tenant_id = p.tenant_id and m.id = p.membership_id
       join user_account u on u.id = m.user_id
      where p.tenant_id = $1 and u.email = 'cardiologia@demo.invalid'`,
    [tenantId],
  );
  const row = found.rows[0];
  if (!row) throw new Error('the demo has no cardiologist');
  cardiologist = { professionalId: row.professional_id, userId: row.user_id };
}, 300_000);

afterAll(async () => {
  await admin.end();
  await runtime.close();
  await rm(workDir, { recursive: true, force: true });
});

/** What a contributor returns for a section: is it an async iterable, an array, or a single value? */
async function shapeOf(kind: ExportKind, contributor: string, section: string) {
  const entry = registry.list(kind).find((candidate) => candidate.name === contributor);
  if (!entry) throw new Error(`no ${kind} contributor "${contributor}"`);
  const context = kind === 'clinical' ? CLINICAL_CONTEXT() : ADMINISTRATIVE_CONTEXT();
  return withTenant(context, async (tx) => {
    const value = (await entry.contribute({
      tx,
      tenantId,
      ...(kind === 'clinical' ? { professionalId: cardiologist.professionalId } : {}),
    })) as Record<string, unknown>;
    const part = value[section];
    if (part !== null && typeof part === 'object' && Symbol.asyncIterator in part) {
      return 'async iterable';
    }
    return Array.isArray(part) ? 'array' : typeof part;
  });
}

async function build(kind: ExportKind, pageSize: number | undefined) {
  const scratch = await mkdtemp(join(workDir, 'package-'));
  const written = await writePackageFile(
    { exports: registry, withTenant, storage, ...(pageSize === undefined ? {} : { pageSize }) },
    {
      tenantId,
      kind,
      ...(kind === 'clinical' ? { professionalId: cardiologist.professionalId } : {}),
      context: kind === 'clinical' ? CLINICAL_CONTEXT() : ADMINISTRATIVE_CONTEXT(),
      organizationName: 'Centro Médico Aillu',
      professionalName: kind === 'clinical' ? 'Dra. Lucía Paz Ferrer' : null,
      now: new Date('2026-10-20T15:00:00Z'),
      scratch,
    },
  );
  return { written, files: readZip(await readFile(written.path)) };
}

describe('the sections that grow with the years', () => {
  it.each(STREAMED.administrative)(
    'administrative %s/%s is an async iterable, not an array that was already loaded',
    async (contributor, section) => {
      expect(await shapeOf('administrative', contributor, section)).toBe('async iterable');
    },
  );

  it.each(STREAMED.clinical)(
    'clinical %s/%s is an async iterable, not an array that was already loaded',
    async (contributor, section) => {
      expect(await shapeOf('clinical', contributor, section)).toBe('async iterable');
    },
  );
});

describe('the pages lose and repeat nothing', () => {
  it('makes the same administrative package with pages of seven rows as with a single page', async () => {
    const paged = await build('administrative', 7);
    const whole = await build('administrative', 1_000_000);

    expect([...paged.files.keys()].sort()).toEqual([...whole.files.keys()].sort());
    expect(paged.files.size).toBeGreaterThan(30);
    for (const [name, bytes] of whole.files) {
      expect(paged.files.get(name)?.equals(bytes), name).toBe(true);
    }
  });

  it('gives every streamed section as many rows as its table has', async () => {
    const { written } = await build('administrative', 7);

    for (const [key, query] of Object.entries(ROWS_OF)) {
      const [contributor, section] = key.split('/');
      const found = written.report.sections.find(
        (candidate) => candidate.contributor === contributor && candidate.section === section,
      );
      const expected = (await admin.query<{ n: number }>(query, [tenantId])).rows[0]?.n ?? -1;
      expect(found?.rows, key).toBe(expected);
    }
    // The pages did fall inside real data: the biggest tables have far more rows than a page.
    const messages = written.report.sections.find((section) => section.section === 'messages');
    const audit = written.report.sections.find((section) => section.section === 'auditEvents');
    expect(messages?.rows ?? 0).toBeGreaterThan(7);
    expect(audit?.rows ?? 0).toBeGreaterThan(100);
  });

  it('makes the same clinical package with pages of seven rows as with a single page, with the record in it', async () => {
    const paged = await build('clinical', 7);
    const whole = await build('clinical', 1_000_000);

    expect([...paged.files.keys()].sort()).toEqual([...whole.files.keys()].sort());
    for (const [name, bytes] of whole.files) {
      expect(paged.files.get(name)?.equals(bytes), name).toBe(true);
    }
    const entries = paged.written.report.sections.find((section) => section.section === 'entries');
    // What the professional is allowed to read, counted with the policies of the database in force:
    // a signed note of theirs or of a patient they treat, which the sharing scope may still hide.
    const expected = await withTenant(CLINICAL_CONTEXT(), (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from clinical_note n
             where n.status = 'signed'
               and (n.author_professional_id = ${cardiologist.professionalId}
                    or n.patient_id in (select patient_id from care_relationship
                                         where professional_id = ${cardiologist.professionalId}
                                           and active))`,
      ),
    );
    expect(entries?.rows).toBe(expected.rows[0]?.n);
    expect(entries?.rows ?? 0).toBeGreaterThan(7);
  });
});

describe('what stays an array', () => {
  it('is bounded by the size of the organization, and the list says which', async () => {
    const stays: [ExportKind, string, string][] = [
      ['administrative', 'tenancy', 'organization'],
      ['administrative', 'staff', 'professionals'],
      ['administrative', 'scheduling', 'appointmentTypes'],
      ['administrative', 'scheduling', 'blocks'],
      ['administrative', 'scheduling', 'daysOff'],
      ['administrative', 'scheduling', 'hoursPeriods'],
      ['administrative', 'patients', 'representatives'],
      ['administrative', 'billing', 'payers'],
      ['administrative', 'billing', 'prices'],
      ['administrative', 'billing', 'cashSessions'],
      ['administrative', 'invoicing', 'fiscalProfiles'],
      ['administrative', 'invoicing', 'pointsOfSale'],
    ];

    for (const [kind, contributor, section] of stays) {
      const shape = await shapeOf(kind, contributor, section);
      expect(['array', 'object'], `${contributor}/${section}`).toContain(shape);
    }
  });
});
