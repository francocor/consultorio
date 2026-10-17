import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  exportAdministrativeDocuments,
  exportClinicalDocuments,
} from '../../src/modules/documents/application/export-contributor.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { minimalPdf } from '../../src/platform/files/test-files.js';
import { withScanning, type ScanningHarness } from '../support/document-scans.js';
import { createDocumentsHarness } from '../support/documents.js';

/**
 * The documents part of the cancellation export (documents, "Retention, export and tenant
 * lifecycle"): every document, hidden ones and previous versions included, in the part that matches
 * its classification, and nothing clinical in the administrative part.
 */
let runtime: DbHandle;
let h: ScanningHarness;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  h = withScanning(await createDocumentsHarness(runtime, 'docs-export'));
});

afterAll(async () => {
  await h.close();
  await runtime.close();
});

async function document(
  session: Parameters<typeof h.upload>[0],
  patientId: string,
  category: 'lab_result' | 'id_copy',
  text: string,
  replacesDocumentId?: string,
) {
  const uploaded = await h.upload(session, {
    patientId,
    category,
    name: `${text}.pdf`,
    bytes: minimalPdf(text),
    ...(replacesDocumentId === undefined ? {} : { replacesDocumentId }),
  });
  await h.runScans();
  return uploaded.id;
}

type Exported = { documents: { id: string; name: string; status: string; objectKey: string }[] };

const asOrganization = <T>(
  run: (tx: Parameters<Parameters<ReturnType<typeof createWithTenant>>[1]>[0]) => Promise<T>,
) => createWithTenant(runtime.db)({ tenantId: h.tenant.id, userId: h.sessions.owner.user.id }, run);

describe('the administrative part', () => {
  it('holds every administrative document, with hidden ones and previous versions, and no clinical one', async () => {
    const patientId = await h.patient();
    const first = await document(h.sessions.reception, patientId, 'id_copy', 'dni-v1');
    const second = await document(h.sessions.reception, patientId, 'id_copy', 'dni-v2', first);
    const hidden = await document(h.sessions.reception, patientId, 'id_copy', 'credencial');
    await h.api.post(`/documents/${hidden}/hide`, h.sessions.reception, {
      reason: 'Error de carga',
    });
    await document(h.sessions.professional, patientId, 'lab_result', 'laboratorio-secreto');

    const part = (await asOrganization((tx) =>
      exportAdministrativeDocuments({ tx, tenantId: h.tenant.id }),
    )) as Exported;

    const mine = part.documents.filter((entry) => [first, second, hidden].includes(entry.id));
    expect(mine.map((entry) => entry.name).sort()).toEqual([
      'credencial.pdf',
      'dni-v1.pdf',
      'dni-v2.pdf',
    ]);
    expect(mine.find((entry) => entry.id === hidden)?.status).toBe('hidden');
    // The exporter needs the key to fetch the file.
    expect(mine.every((entry) => entry.objectKey.startsWith(`t/${h.tenant.id}/docs/`))).toBe(true);
    expect(JSON.stringify(part)).not.toContain('laboratorio-secreto');
  });
});

describe('the clinical part, one package per professional', () => {
  it("holds the clinical documents of the professional's own patients, and nothing else", async () => {
    const mine = await h.patient();
    const notMine = await h.patient({ treatedBy: 'nobody' });
    const kept = await document(h.sessions.professional, mine, 'lab_result', 'del-paciente-propio');
    await document(h.sessions.reception, mine, 'id_copy', 'administrativo');
    // A patient of a colleague, with a clinical document the colleague wrote.
    await h.upload(h.sessions.colleague, {
      patientId: notMine,
      category: 'id_copy',
      bytes: minimalPdf('de-otro'),
    });

    const part = (await createWithTenant(runtime.db)(
      {
        tenantId: h.tenant.id,
        userId: h.sessions.professional.user.id,
        actingProfessionalId: h.professionalId,
      },
      (tx) =>
        exportClinicalDocuments({ tx, tenantId: h.tenant.id, professionalId: h.professionalId }),
    )) as Exported;

    expect(part.documents.map((entry) => entry.id)).toContain(kept);
    expect(part.documents.every((entry) => !entry.name.includes('administrativo'))).toBe(true);
    expect(part.documents.every((entry) => !entry.name.includes('de-otro'))).toBe(true);
  });

  it('is empty for a package that names no professional', async () => {
    const part = (await asOrganization((tx) =>
      exportClinicalDocuments({ tx, tenantId: h.tenant.id }),
    )) as Exported;

    expect(part.documents).toEqual([]);
  });
});
