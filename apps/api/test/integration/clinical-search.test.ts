import { randomBytes } from 'node:crypto';

import {
  Problem,
  SEARCH_ENTRY_CAP,
  type AuditAction,
  type SearchResponse,
  type NoteDto,
} from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { tenant } from '../../src/db/schema/tenant.js';
import type { KeyManagement } from '../../src/platform/crypto/key-management.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';
import {
  createClinicalWorld,
  type ClinicalWorld,
  type Professional,
} from '../support/clinical-world.js';
import { clientFor } from '../support/session.js';
import { asTenant } from '../support/tenants.js';

/**
 * Per-patient clinical search (clinical-records, "Patient clinical timeline"; design 4.3): the
 * entries of one patient are decrypted in memory, folded and matched; nothing is indexed.
 */
let runtime: DbHandle;
let world: ClinicalWorld;
let author: Professional;
let colleague: Professional;
let stranger: Professional;
const kek = randomBytes(32).toString('base64');
const unwraps = { count: 0 };

/** The local key service, counting how many times a data key is unwrapped. */
function countingKms(): KeyManagement {
  const inner = createLocalKeyManagement(kek);
  return {
    generateDataKey: (context) => inner.generateDataKey(context),
    unwrapDataKey: (wrapped, context) => {
      unwraps.count += 1;
      return inner.unwrapDataKey(wrapped, context);
    },
  };
}

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createClinicalWorld(runtime, 'clinical-search', {
    keys: createTenantKeys({ kms: countingKms() }),
    clinical: { searchCap: 6 },
  });
  author = await world.professional();
  colleague = await world.professional();
  stranger = await world.professional();
});

beforeEach(async () => {
  await asTenant(runtime, world.tenant.id, (tx) =>
    tx.update(tenant).set({ settings: {} }).where(eq(tenant.id, world.tenant.id)),
  );
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

async function signed(
  by: Professional,
  patientId: string,
  content: object,
  options: { visibility?: string; templateKind?: string } = {},
): Promise<NoteDto> {
  const draft = await world.open(by, patientId, options);
  await world.api.put(`/encounters/${draft.encounterId}/note/draft`, by.session, {
    content,
    baseRevision: 0,
  });
  const response = await world.api.post(`/notes/${draft.id}/sign`, by.session, {
    expectedRevision: 1,
  });
  return response.json<NoteDto>();
}

const search = (patientId: string, by: Professional, query: string) =>
  world.api.get(`/patients/${patientId}/clinical/search?${query}`, by.session);

async function rows(action: AuditAction, patientId: string) {
  const found = await asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action))),
  );
  return found.filter((row) => row.patientId === patientId);
}

describe('searching one patient', () => {
  it('finds a term without regard to accents or case, with a snippet of the words as written', async () => {
    const patientId = await world.patient();
    const note = await signed(author, patientId, {
      reasonForConsultation: 'Control',
      diagnosis: 'Paciente con HIPERTENSIÓN arterial leve',
    });
    await signed(author, patientId, { reasonForConsultation: 'Resfrío común' });

    for (const q of ['hipertension', 'HIPERTENSIÓN', 'hipertensión%20arterial']) {
      const response = await search(patientId, author, `q=${q}`);

      expect(response.statusCode, q).toBe(200);
      const body = response.json<SearchResponse>();
      expect(body.hits).toHaveLength(1);
      expect(body.hits[0]).toMatchObject({ noteId: note.id, inAddendum: false });
      expect(body.hits[0]?.snippet).toContain('HIPERTENSIÓN arterial leve');
      expect(body.scanned).toBe(2);
    }
  });

  it('returns nothing, with the number scanned, when no entry has the term', async () => {
    const patientId = await world.patient();
    await signed(author, patientId, { reasonForConsultation: 'Control' });

    const response = await search(patientId, author, 'q=hipertension');

    expect(response.json<SearchResponse>()).toEqual({ hits: [], scanned: 1 });
  });

  it('finds a term that is only in an addendum', async () => {
    const patientId = await world.patient([author, colleague]);
    const note = await signed(author, patientId, { reasonForConsultation: 'Control' });
    await world.api.post(`/notes/${note.id}/addenda`, colleague.session, {
      kind: 'correction',
      reason: 'Alergia olvidada',
      text: 'Alergia a la dipirona',
    });

    const body = (await search(patientId, author, 'q=dipirona')).json<SearchResponse>();

    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]).toMatchObject({ noteId: note.id, inAddendum: true });
  });

  it('honors visibility: an entry restricted to its author is not returned and not counted', async () => {
    const patientId = await world.patient([author, colleague]);
    await signed(
      author,
      patientId,
      { reasonForConsultation: 'Hipertensión reservada' },
      { visibility: 'author_only' },
    );
    const open = await signed(author, patientId, { reasonForConsultation: 'Hipertensión abierta' });

    const asColleague = (
      await search(patientId, colleague, 'q=hipertension')
    ).json<SearchResponse>();
    const asAuthor = (await search(patientId, author, 'q=hipertension')).json<SearchResponse>();

    expect(asColleague.hits.map((hit) => hit.noteId)).toEqual([open.id]);
    expect(asColleague.scanned).toBe(1);
    expect(asAuthor.hits).toHaveLength(2);
    expect(JSON.stringify(asColleague)).not.toContain('reservada');
  });

  it('never returns the entries of another patient', async () => {
    const patientId = await world.patient();
    const other = await world.patient();
    await signed(author, patientId, { reasonForConsultation: 'Migraña' });
    await signed(author, other, { reasonForConsultation: 'Migraña también' });

    const body = (await search(patientId, author, 'q=migrana')).json<SearchResponse>();

    expect(body.hits).toHaveLength(1);
    expect(body.scanned).toBe(1);
  });

  it('refuses a term of fewer than two characters and a reversed range', async () => {
    const patientId = await world.patient();

    expect((await search(patientId, author, 'q=a')).statusCode).toBe(400);
    expect(
      (await search(patientId, author, 'q=tos&from=2026-05-01&to=2026-04-01')).statusCode,
    ).toBe(400);
  });

  it('refuses a professional with no relationship to the patient, and audits it', async () => {
    const patientId = await world.patient();
    await signed(author, patientId, { reasonForConsultation: 'Algo' });

    const response = await search(patientId, stranger, 'q=algo');

    expect(response.statusCode).toBe(403);
    expect((await rows('access.denied', patientId))[0]).toMatchObject({
      reason: 'search_not_readable',
      actorUserId: stranger.session.user.id,
    });
  });

  it('offers no search across patients', async () => {
    for (const url of [
      '/clinical/search?q=tos',
      '/patients/clinical/search?q=tos',
      '/search/clinical?q=tos',
    ]) {
      expect((await world.api.get(url, author.session)).statusCode, url).toBe(404);
    }
    const routes = [...world.app.routePermissions.keys()].filter(
      (route) => /search/i.test(route) && !route.startsWith('HEAD '),
    );
    expect(routes).toEqual(['GET /patients/:id/clinical/search']);
  });
});

describe('the cap', () => {
  it('asks for a date range once the record is larger than the cap, and honors the range', async () => {
    const patientId = await world.patient();
    for (let index = 0; index < 8; index += 1) {
      await signed(author, patientId, {
        reasonForConsultation: `Consulta numero ${String(index)} con tos`,
      });
    }

    const refused = await search(patientId, author, 'q=tos');
    const ranged = await search(patientId, author, 'q=tos&from=2020-01-01&to=2099-12-31');

    expect(refused.statusCode).toBe(400);
    expect(Problem.parse(refused.json()).errors).toEqual([
      { path: 'from', i18nKey: 'clinical.search.range_required' },
    ]);
    expect(ranged.statusCode).toBe(200);
    const body = ranged.json<SearchResponse>();
    expect(body.scanned).toBe(6);
    expect(body.hits).toHaveLength(6);
  });

  it('is 2,000 entries by default', () => {
    expect(SEARCH_ENTRY_CAP).toBe(2000);
  });

  it('applies the date range to the signature date of the entries', async () => {
    const patientId = await world.patient();
    await signed(author, patientId, { reasonForConsultation: 'Control con tos' });

    const past = await search(patientId, author, 'q=tos&from=2020-01-01&to=2020-12-31');
    const today = await search(patientId, author, 'q=tos&from=2020-01-01&to=2099-12-31');

    expect(past.json<SearchResponse>()).toEqual({ hits: [], scanned: 0 });
    expect(today.json<SearchResponse>().hits).toHaveLength(1);
  });
});

describe('what a search leaves behind', () => {
  it('audits one read per entry returned and one search, without the term or the content', async () => {
    const patientId = await world.patient();
    await signed(author, patientId, { reasonForConsultation: 'Lumbalgia aguda' });
    await signed(author, patientId, { reasonForConsultation: 'Lumbalgia crónica' });
    await signed(author, patientId, { reasonForConsultation: 'Resfrío' });

    await search(patientId, author, 'q=lumbalgia');
    const reads = (await rows('clinical.note.read', patientId)).filter(
      (row) => (row.metadata as { via?: string }).via === 'search',
    );
    const searches = await rows('clinical.search', patientId);

    expect(reads).toHaveLength(2);
    expect(searches).toHaveLength(1);
    expect(searches[0]?.metadata).toMatchObject({ hits: 2, scanned: 3 });
    expect(JSON.stringify([...reads, ...searches])).not.toMatch(/lumbalgia/i);
  });

  it('unwraps the data key once for the whole request, however many entries it decrypts', async () => {
    const patientId = await world.patient();
    for (let index = 0; index < 5; index += 1) {
      await signed(author, patientId, {
        reasonForConsultation: `Visita ${String(index)} con fiebre`,
      });
    }
    // A second application over the same database has a cold key cache.
    const cold = buildTestApplication(runtime, {
      keys: createTenantKeys({ kms: countingKms() }),
      clinical: { searchCap: 50 },
    });
    try {
      const before = unwraps.count;

      const response = await clientFor(cold, 'clinical-search').get(
        `/patients/${patientId}/clinical/search?q=fiebre`,
        author.session,
      );

      expect(response.json<SearchResponse>().hits).toHaveLength(5);
      expect(unwraps.count - before).toBe(1);
    } finally {
      await cold.close();
    }
  });
});
