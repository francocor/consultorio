import { randomBytes } from 'node:crypto';

import type { NoteDto, SearchResponse, TimelineResponse } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { tenant } from '../../src/db/schema/tenant.js';
import { registerAllExportContributors } from '../../src/main/export-contributors.js';
import { exportClinical } from '../../src/modules/clinical/application/export-contributor.js';
import { createExportRegistry } from '../../src/modules/tenancy/index.js';
import { createTenantKeys, type TenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import {
  createClinicalWorld,
  type ClinicalWorld,
  type Professional,
} from '../support/clinical-world.js';
import { asProfessional } from '../support/clinical.js';
import { asTenant } from '../support/tenants.js';

/**
 * Retention and availability (clinical-records, "Retention and availability"): clinical data is
 * never deleted, stays readable when the organization is read-only or a professional leaves, and
 * is delivered by the clinical part of the cancellation export, per professional.
 */
let runtime: DbHandle;
let owner: pg.Client;
let world: ClinicalWorld;
let keys: TenantKeys;
let author: Professional;
let colleague: Professional;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  keys = createTenantKeys({ kms: createLocalKeyManagement(randomBytes(32).toString('base64')) });
  world = await createClinicalWorld(runtime, 'clinical-retention', { keys });
  author = await world.professional();
  colleague = await world.professional();
});

afterAll(async () => {
  await world.close();
  await owner.end();
  await runtime.close();
});

async function signed(by: Professional, patientId: string, content: object, options = {}) {
  const draft = await world.open(by, patientId, options);
  await world.api.put(`/encounters/${draft.encounterId}/note/draft`, by.session, {
    content,
    baseRevision: 0,
  });
  return (await world.api.post(`/notes/${draft.id}/sign`, by.session, {})).json<NoteDto>();
}

describe('a read-only organization', () => {
  it('keeps every clinical read available to the treating professional', async () => {
    const patientId = await world.patient([colleague]);
    const note = await signed(author, patientId, { reasonForConsultation: 'Control de rutina' });
    await asTenant(runtime, world.tenant.id, (tx) =>
      tx
        .update(tenant)
        .set({ status: 'read_only', readOnlySince: new Date() })
        .where(eq(tenant.id, world.tenant.id)),
    );
    try {
      const reads = await Promise.all([
        world.api.get(`/notes/${note.id}`, colleague.session),
        world.api.get(`/notes/${note.id}/versions`, colleague.session),
        world.api.get(`/patients/${patientId}/clinical/timeline`, colleague.session),
        world.api.get(`/patients/${patientId}/clinical/search?q=rutina`, colleague.session),
        world.api.get('/clinical/drafts', colleague.session),
      ]);

      expect(reads.map((response) => response.statusCode)).toEqual([200, 200, 200, 200, 200]);
      expect(reads[2].json<TimelineResponse>().entries).toHaveLength(1);
      expect(reads[3].json<SearchResponse>().hits).toHaveLength(1);
    } finally {
      await asTenant(runtime, world.tenant.id, (tx) =>
        tx
          .update(tenant)
          .set({ status: 'active', readOnlySince: null })
          .where(eq(tenant.id, world.tenant.id)),
      );
    }
  });
});

describe('nothing clinical is ever deleted', () => {
  it('has no route that deletes, edits a signed entry or lists history for removal', () => {
    const routes = [...world.app.routePermissions.keys()];
    const clinical = routes.filter((route) =>
      /(notes|encounters|clinical|addenda|versions)/.test(route),
    );

    expect(clinical.length).toBeGreaterThan(8);
    expect(clinical.filter((route) => route.startsWith('DELETE '))).toEqual([]);
    expect(clinical.filter((route) => route.startsWith('PATCH '))).toEqual([]);
  });

  it('keeps the rows when the professional who wrote them leaves the organization', async () => {
    const leaver = await world.professional();
    const patientId = await world.patient([colleague]);
    const note = await signed(leaver, patientId, { reasonForConsultation: 'Antes de irse' });

    const deactivated = await world.api.post(
      `/staff/${leaver.session.user.membershipId}/deactivate`,
      world.owner,
    );
    const still = await world.api.get(`/notes/${note.id}`, colleague.session);

    expect(deactivated.statusCode).toBe(200);
    expect(still.statusCode).toBe(200);
    expect(still.json<NoteDto>()).toMatchObject({
      content: { reasonForConsultation: 'Antes de irse' },
      author: { professionalId: leaver.professionalId },
    });
  });

  it('refuses a delete or a truncate from the application role', async () => {
    const result = await owner.query<{ del: boolean }>(
      `SELECT bool_or(has_table_privilege('app_rw', t, 'DELETE') OR has_table_privilege('app_rw', t, 'TRUNCATE')) AS del
         FROM unnest(ARRAY['encounter', 'clinical_note', 'note_version', 'addendum']) AS t`,
    );

    expect(result.rows[0]?.del).toBe(false);
    await expect(
      asProfessional(runtime, world.tenant.id, author.professionalId, (tx) =>
        tx.execute(sql`DELETE FROM addendum`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('the clinical part of the export', () => {
  it('is registered for the clinical module, per professional', () => {
    const registry = createExportRegistry();

    registerAllExportContributors(registry, { keys });

    expect(registry.list('clinical').map((entry) => entry.name)).toContain('clinical');
  });

  it("delivers the signed entries of the professional's own patients, decrypted, without entries in error", async () => {
    const patientId = await world.patient();
    const kept = await signed(author, patientId, { reasonForConsultation: 'Para exportar' });
    const wrong = await signed(author, patientId, { reasonForConsultation: 'Equivocada' });
    await world.api.post(`/notes/${wrong.id}/entered-in-error`, author.session, {
      reason: 'Duplicada',
    });
    await world.api.post(`/notes/${kept.id}/addenda`, author.session, {
      kind: 'correction',
      reason: 'Aclaración',
      text: 'Se agrega un dato',
    });
    await signed(
      author,
      patientId,
      { reasonForConsultation: 'Reservada' },
      { visibility: 'author_only' },
    );

    const part = (await createWithTenant(runtime.db)(
      {
        tenantId: world.tenant.id,
        userId: author.session.user.id,
        actingProfessionalId: author.professionalId,
      },
      (tx) =>
        exportClinical(keys)({
          tx,
          tenantId: world.tenant.id,
          professionalId: author.professionalId,
        }),
    )) as {
      entries: { noteId: string; content: Record<string, unknown>; addenda: unknown[] }[];
      excludedEnteredInError: number;
    };

    const mine = part.entries.filter(
      (entry) => entry.content['reasonForConsultation'] === 'Para exportar',
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.addenda).toHaveLength(1);
    expect(part.entries.some((entry) => entry.noteId === wrong.id)).toBe(false);
    expect(part.excludedEnteredInError).toBeGreaterThanOrEqual(1);
  });

  it("does not hand one professional another's restricted entries", async () => {
    const patientId = await world.patient([colleague]);
    await signed(
      author,
      patientId,
      { reasonForConsultation: 'Solo del autor' },
      { visibility: 'author_only' },
    );
    await signed(author, patientId, { reasonForConsultation: 'Compartida con quien trata' });

    const part = (await createWithTenant(runtime.db)(
      {
        tenantId: world.tenant.id,
        userId: colleague.session.user.id,
        actingProfessionalId: colleague.professionalId,
      },
      (tx) =>
        exportClinical(keys)({
          tx,
          tenantId: world.tenant.id,
          professionalId: colleague.professionalId,
        }),
    )) as { entries: { content: Record<string, unknown> }[] };

    const texts = part.entries.map((entry) => entry.content['reasonForConsultation']);
    expect(texts).toContain('Compartida con quien trata');
    expect(texts).not.toContain('Solo del autor');
  });

  it('refuses to run without the key service rather than exporting nothing', async () => {
    const unkeyed = createExportRegistry();
    registerAllExportContributors(unkeyed);
    const contributor = unkeyed.list('clinical').find((entry) => entry.name === 'clinical');

    await expect(
      createWithTenant(runtime.db)(
        {
          tenantId: world.tenant.id,
          userId: author.session.user.id,
          actingProfessionalId: author.professionalId,
        },
        (tx) =>
          (contributor?.contribute ?? (() => Promise.resolve()))({
            tx,
            tenantId: world.tenant.id,
            professionalId: author.professionalId,
          }),
      ),
    ).rejects.toThrow(/key service/);
  });
});
