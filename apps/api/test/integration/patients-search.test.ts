import {
  PatientSummaryDto,
  type CreatePatientResponse,
  type PatientSearchResponse,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let app: FastifyInstance;
let api: ReturnType<typeof clientFor>;
let tenant: TestTenant;
let other: TestTenant;
let reception: TestSession;
let doctor: TestSession;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  tenant = await createTestTenant(runtime, { slug: 'patients-search' });
  other = await createTestTenant(runtime, { slug: 'patients-search-b' });
  app = buildTestApplication(runtime);
  api = clientFor(app, 'patients-search');
  const make = (roles: ('reception' | 'professional')[]) =>
    createTestUser(runtime, tenant.id, { roles, password: TEST_PASSWORD });
  reception = await signInAs(app, 'patients-search', await make(['reception']));
  doctor = await signInAs(app, 'patients-search', await make(['professional']));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

async function register(body: Record<string, unknown>, slug = 'patients-search', by = reception) {
  const response = await clientFor(app, slug).post('/patients', by, {
    birthDate: '1985-03-02',
    dataProcessingConsent: true,
    ...body,
  });
  expect(response.statusCode).toBe(201);
  return response.json<CreatePatientResponse>().patient;
}

const search = async (query: string, by: TestSession = reception) => {
  const response = await api.get(`/patients${query}`, by);
  expect(response.statusCode).toBe(200);
  return response.json<PatientSearchResponse>();
};
const names = (page: PatientSearchResponse) =>
  page.patients.map((patient) => `${patient.familyName}, ${patient.givenNames}`);

describe('searching the registry', () => {
  beforeAll(async () => {
    await register({ familyName: 'Pérez', givenNames: 'María José', phone: '+54 11 5555-1234' });
    await register({
      familyName: 'Peralta',
      givenNames: 'Ana',
      document: { type: 'dni', number: '30.123.456' },
    });
    await register({ familyName: 'Gómez', givenNames: 'Ana María', phone: '11 4000-9876' });
    await register({ familyName: 'Núñez', givenNames: 'Ñandú' });
  });

  it('ignores accents and case, in the query and in the data', async () => {
    for (const q of ['perez', 'PEREZ', 'pérez', 'PÉREZ']) {
      expect(names(await search(`?q=${encodeURIComponent(q)}`)), q).toEqual(['Pérez, María José']);
    }
    expect(names(await search(`?q=${encodeURIComponent('nandu')}`))).toEqual(['Núñez, Ñandú']);
    expect(names(await search(`?q=${encodeURIComponent('nunez')}`))).toEqual(['Núñez, Ñandú']);
  });

  it('needs every word to match, in any order, in the family or the given names', async () => {
    expect(names(await search(`?q=${encodeURIComponent('ana gomez')}`))).toEqual([
      'Gómez, Ana María',
    ]);
    expect(names(await search(`?q=${encodeURIComponent('gomez ana')}`))).toEqual([
      'Gómez, Ana María',
    ]);
    expect(await search(`?q=${encodeURIComponent('ana perez')}`)).toMatchObject({ patients: [] });
  });

  it('finds by the start of a document however it was typed, and by phone digits', async () => {
    expect(names(await search(`?q=${encodeURIComponent('30.123')}`))).toEqual(['Peralta, Ana']);
    expect(names(await search('?q=30123456'))).toEqual(['Peralta, Ana']);
    expect(names(await search(`?q=${encodeURIComponent('5555-1234')}`))).toEqual([
      'Pérez, María José',
    ]);
    expect(names(await search('?q=40009876'))).toEqual(['Gómez, Ana María']);
  });

  it('returns only the minimal columns, and nothing that is not in the summary', async () => {
    const page = await search('?q=peralta');

    expect(page.patients).toHaveLength(1);
    expect(Object.keys(page.patients[0] ?? {}).sort()).toEqual(
      Object.keys(PatientSummaryDto.shape).sort(),
    );
    expect(page.patients[0]).toMatchObject({
      document: { type: 'dni', number: '30123456' },
      hasSafetyFlag: false,
    });
  });

  it('treats % and _ as plain characters', async () => {
    expect((await search(`?q=${encodeURIComponent('%')}`)).patients).toEqual([]);
    expect((await search(`?q=${encodeURIComponent('_')}`)).patients).toEqual([]);
    expect((await search(`?q=${encodeURIComponent('p_rez')}`)).patients).toEqual([]);
  });

  it('is open to any staff member and closed without a session', async () => {
    expect(names(await search('?q=perez', doctor))).toEqual(['Pérez, María José']);
    expect((await api.get('/patients?q=perez', null)).statusCode).toBe(401);
  });

  it("never returns another organization's patients", async () => {
    const elsewhere = await createTestUser(runtime, other.id, {
      roles: ['reception'],
      password: TEST_PASSWORD,
    });
    const session = await signInAs(app, 'patients-search-b', elsewhere);
    await register({ familyName: 'Pérez', givenNames: 'Ajena' }, 'patients-search-b', session);

    expect(names(await search('?q=perez'))).toEqual(['Pérez, María José']);
  });
});

describe('paging and status', () => {
  it('walks the whole list in a stable order, a page at a time, without repeats', async () => {
    const pagedTenant = await createTestTenant(runtime, { slug: 'patients-search-pages' });
    const user = await createTestUser(runtime, pagedTenant.id, {
      roles: ['reception'],
      password: TEST_PASSWORD,
    });
    const session = await signInAs(app, 'patients-search-pages', user);
    const paged = clientFor(app, 'patients-search-pages');
    for (const family of [
      'Alvarez',
      'Benitez',
      'Benitez',
      'Castro',
      'Dominguez',
      'Echeverria',
      'Fuentes',
    ]) {
      await register(
        { familyName: family, givenNames: 'Persona' },
        'patients-search-pages',
        session,
      );
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await paged.get(
        `/patients?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        session,
      );
      const page: PatientSearchResponse = response.json<PatientSearchResponse>();
      seen.push(...page.patients.map((patient) => patient.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('refuses a cursor that is not one, and a limit outside 1 to 100', async () => {
    expect((await api.get('/patients?cursor=not-a-cursor', reception)).statusCode).toBe(400);
    expect((await api.get('/patients?limit=0', reception)).statusCode).toBe(400);
    expect((await api.get('/patients?limit=101', reception)).statusCode).toBe(400);
  });

  it('hides inactive patients by default, and lists them on request', async () => {
    const gone = await register({ familyName: 'Inactivo', givenNames: 'Uno' });
    await api.post(`/patients/${gone.id}/deactivate`, reception);

    expect(names(await search('?q=inactivo'))).toEqual([]);
    expect(names(await search('?q=inactivo&status=inactive'))).toEqual(['Inactivo, Uno']);
    expect(names(await search('?q=inactivo&status=all'))).toEqual(['Inactivo, Uno']);
  });
});

describe('a large registry', () => {
  it('answers a search among 10,000 patients well inside a generous bound', async () => {
    const big = await createTestTenant(runtime, { slug: 'patients-search-big' });
    const user = await createTestUser(runtime, big.id, {
      roles: ['reception'],
      password: TEST_PASSWORD,
    });
    const session = await signInAs(app, 'patients-search-big', user);
    await asTenant(runtime, big.id, (tx) =>
      tx.execute(sql`
        insert into patient (tenant_id, family_name, given_names, birth_date, national_id_type, national_id, phone)
        select ${big.id},
               (array['García','Pérez','López','Martínez','Rodríguez','Fernández','Gómez','Díaz'])[1 + (g % 8)] || ' ' || g,
               (array['Ana','Luis','María','José'])[1 + (g % 4)],
               date '1950-01-01' + (g % 20000),
               'dni',
               (20000000 + g)::text,
               '11' || (40000000 + g)::text
          from generate_series(1, 10000) as g`),
    );
    await asTenant(runtime, big.id, (tx) =>
      tx.execute(sql`analyze patient`).catch(() => undefined),
    );
    const bigApi = clientFor(app, 'patients-search-big');

    const timed = async (query: string) => {
      const started = performance.now();
      const response = await bigApi.get(`/patients${query}`, session);
      return { response, ms: performance.now() - started };
    };
    const byName = await timed(`?q=${encodeURIComponent('garcia 77')}&limit=25`);
    const byDocument = await timed('?q=20005000');
    const byPhone = await timed('?q=40001234');
    const firstPage = await timed('?limit=25');

    expect(byName.response.json<PatientSearchResponse>().patients.length).toBeGreaterThan(0);
    expect(byDocument.response.json<PatientSearchResponse>().patients).toHaveLength(1);
    expect(byPhone.response.json<PatientSearchResponse>().patients).toHaveLength(1);
    expect(firstPage.response.json<PatientSearchResponse>().nextCursor).not.toBeNull();
    for (const { ms } of [byName, byDocument, byPhone, firstPage]) {
      expect(ms).toBeLessThan(2000);
    }
  });
});
