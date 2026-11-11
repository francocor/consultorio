import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { Tx } from '../../src/platform/db/tenant-context.js';
import { insertConsentTemplate, insertConsentTemplateVersion } from '../support/consent-rows.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

/**
 * The tables of consent and what the database itself refuses (informed-consent, "Template
 * versioning" and "Immutability of signed consents"). The rules do not rest on the application:
 * a published version cannot change for the runtime role (no UPDATE privilege) and not for the
 * migration owner either (a trigger).
 */
let runtime: DbHandle;
let owner: pg.Client;
let a: TestTenant;
let b: TestTenant;

const IMMUTABLE = '23000';
const NOT_ALLOWED = '42501';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  a = await createTestTenant(runtime, { slug: 'consent-schema-a' });
  b = await createTestTenant(runtime, { slug: 'consent-schema-b' });
});

afterAll(async () => {
  await owner.end();
  await runtime.close();
});

/** The SQLSTATE of a refused statement, run in a savepoint so the transaction stays usable. */
const refusal = (tx: Tx, work: (inner: Tx) => Promise<unknown>) =>
  tx.transaction(work).then(
    () => undefined,
    (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
  );

/** Runs a statement as the migration owner, in the tenant, inside a transaction that is rolled back. */
async function asOwner(tenantId: string, work: (client: pg.Client) => Promise<unknown>) {
  await owner.query('BEGIN');
  try {
    await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    return await work(owner);
  } finally {
    await owner.query('ROLLBACK');
  }
}

describe('consent_template', () => {
  it('starts as a draft with the working copy of the text', async () => {
    const row = await asTenant(runtime, a.id, async (tx) => {
      const id = await insertConsentTemplate(tx, a.id);
      return (
        await tx.execute(sql`SELECT status, draft_body FROM consent_template WHERE id = ${id}`)
      ).rows[0];
    });

    expect(row).toMatchObject({ status: 'draft', draft_body: 'Texto del consentimiento.' });
  });

  it('refuses a status that is not draft, published or retired, and a blank title', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const id = await insertConsentTemplate(tx, a.id);
      return [
        await refusal(tx, (inner) =>
          inner.execute(
            sql`INSERT INTO consent_template (tenant_id, title, status, created_by)
                  VALUES (${a.id}, 'Titulo', 'archived', gen_random_uuid())`,
          ),
        ),
        await refusal(tx, (inner) =>
          inner.execute(sql`UPDATE consent_template SET title = '   ' WHERE id = ${id}`),
        ),
      ];
    });

    expect(codes).toEqual([CHECK_VIOLATION, CHECK_VIOLATION]);
  });

  it('is retired with who and when, never without them', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const id = await insertConsentTemplate(tx, a.id);
      const withoutWho = await refusal(tx, (inner) =>
        inner.execute(sql`UPDATE consent_template SET status = 'retired' WHERE id = ${id}`),
      );
      const complete = await refusal(tx, (inner) =>
        inner.execute(
          sql`UPDATE consent_template
                 SET status = 'retired', retired_at = now(), retired_by = gen_random_uuid()
               WHERE id = ${id}`,
        ),
      );
      return { withoutWho, complete };
    });

    expect(codes).toEqual({ withoutWho: CHECK_VIOLATION, complete: undefined });
  });

  it('never comes back from retired, and its organization and author never change', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const id = await insertConsentTemplate(tx, a.id);
      await tx.execute(
        sql`UPDATE consent_template
               SET status = 'retired', retired_at = now(), retired_by = gen_random_uuid()
             WHERE id = ${id}`,
      );
      const revived = await refusal(tx, (inner) =>
        inner.execute(
          sql`UPDATE consent_template
                 SET status = 'draft', retired_at = null, retired_by = null
               WHERE id = ${id}`,
        ),
      );
      const retitled = await refusal(tx, (inner) =>
        inner.execute(sql`UPDATE consent_template SET title = 'Otro titulo' WHERE id = ${id}`),
      );
      return { revived, retitled };
    });

    expect(codes).toEqual({ revived: IMMUTABLE, retitled: IMMUTABLE });
  });

  it('cannot go from draft straight back after publishing, and cannot change who created it', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const id = await insertConsentTemplate(tx, a.id);
      await tx.execute(sql`UPDATE consent_template SET status = 'published' WHERE id = ${id}`);
      const backToDraft = await refusal(tx, (inner) =>
        inner.execute(sql`UPDATE consent_template SET status = 'draft' WHERE id = ${id}`),
      );
      const otherAuthor = await refusal(tx, (inner) =>
        inner.execute(
          sql`UPDATE consent_template SET created_by = gen_random_uuid() WHERE id = ${id}`,
        ),
      );
      return { backToDraft, otherAuthor };
    });

    expect(codes).toEqual({ backToDraft: IMMUTABLE, otherAuthor: IMMUTABLE });
  });

  it('is never deleted by the runtime role', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const id = await insertConsentTemplate(tx, a.id);
      return refusal(tx, (inner) =>
        inner.execute(sql`DELETE FROM consent_template WHERE id = ${id}`),
      );
    });

    expect(code).toBe(NOT_ALLOWED);
  });
});

describe('consent_template_version', () => {
  it('numbers versions within a template and refuses a repeated number', async () => {
    const code = await asTenant(runtime, a.id, async (tx) => {
      const versionId = await insertConsentTemplateVersion(tx, a.id);
      const templateId = (
        await tx.execute<{ template_id: string }>(
          sql`SELECT template_id FROM consent_template_version WHERE id = ${versionId}`,
        )
      ).rows[0]?.template_id;
      return refusal(tx, (inner) =>
        inner.execute(
          sql`INSERT INTO consent_template_version
                (tenant_id, template_id, version_number, title, body, content_hash, published_by)
                VALUES (${a.id}, ${templateId}, 1, 'Otro', 'Otro texto', ${'b'.repeat(64)}, gen_random_uuid())`,
        ),
      );
    });

    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('refuses a version number below one, a hash that is not a SHA-256 and an empty text', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const templateId = await insertConsentTemplate(tx, a.id);
      const insert = (number: number, hash: string, body: string) =>
        refusal(tx, (inner) =>
          inner.execute(
            sql`INSERT INTO consent_template_version
                  (tenant_id, template_id, version_number, title, body, content_hash, published_by)
                  VALUES (${a.id}, ${templateId}, ${number}, 'Titulo', ${body}, ${hash}, gen_random_uuid())`,
          ),
        );
      return [
        await insert(0, 'a'.repeat(64), 'Texto'),
        await insert(2, 'not-a-hash', 'Texto'),
        await insert(3, 'a'.repeat(64), '   '),
        await insert(4, 'a'.repeat(64), 'Texto'),
      ];
    });

    expect(codes).toEqual([CHECK_VIOLATION, CHECK_VIOLATION, CHECK_VIOLATION, undefined]);
  });

  it('cannot be updated or deleted by the runtime role: the privilege is gone', async () => {
    const codes = await asTenant(runtime, a.id, async (tx) => {
      const id = await insertConsentTemplateVersion(tx, a.id);
      return [
        await refusal(tx, (inner) =>
          inner.execute(
            sql`UPDATE consent_template_version SET body = 'Otro texto' WHERE id = ${id}`,
          ),
        ),
        await refusal(tx, (inner) =>
          inner.execute(sql`DELETE FROM consent_template_version WHERE id = ${id}`),
        ),
      ];
    });

    expect(codes).toEqual([NOT_ALLOWED, NOT_ALLOWED]);
  });

  it('cannot be changed by the migration owner either: a trigger refuses', async () => {
    const id = await asTenant(runtime, a.id, (tx) => insertConsentTemplateVersion(tx, a.id));

    const results = await asOwner(a.id, async (client) => {
      const codes: (string | undefined)[] = [];
      for (const statement of [
        `UPDATE consent_template_version SET body = 'Otro texto' WHERE id = '${id}'`,
        `DELETE FROM consent_template_version WHERE id = '${id}'`,
      ]) {
        await client.query('SAVEPOINT attempt');
        try {
          await client.query(statement);
          codes.push(undefined);
        } catch (error) {
          codes.push((error as { code?: string }).code);
          await client.query('ROLLBACK TO attempt');
        }
      }
      return codes;
    });

    expect(results).toEqual([IMMUTABLE, IMMUTABLE]);
  });
});

describe('isolation between organizations', () => {
  it('hides the templates and versions of an organization from another one', async () => {
    const { templateId, versionId } = await asTenant(runtime, a.id, async (tx) => {
      const versionId = await insertConsentTemplateVersion(tx, a.id);
      const rows = await tx.execute<{ template_id: string }>(
        sql`SELECT template_id FROM consent_template_version WHERE id = ${versionId}`,
      );
      return { templateId: rows.rows[0]?.template_id ?? '', versionId };
    });

    const counts = await asTenant(runtime, b.id, async (tx) => {
      const templates = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM consent_template WHERE id = ${templateId}`,
      );
      const versions = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM consent_template_version WHERE id = ${versionId}`,
      );
      return { templates: templates.rows[0]?.n, versions: versions.rows[0]?.n };
    });

    expect(counts).toEqual({ templates: 0, versions: 0 });
  });
});
