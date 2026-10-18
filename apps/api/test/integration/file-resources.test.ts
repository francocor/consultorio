import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { MODULE_WIRINGS } from '../../src/main/wiring/index.js';
import type { ModuleWiring } from '../../src/main/wiring/types.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { FileRefused } from '../../src/platform/files/file-resources.js';
import { AppError } from '../../src/platform/http/problem.js';
import { createActionTokens } from '../../src/platform/tokens/index.js';
import { TOKEN_KIND_REGISTRY } from '../../src/platform/tokens/kinds.js';
import { browserHeaders } from '../support/app.js';
import { asSystem, createDocumentsHarness, type DocumentsHarness } from '../support/documents.js';
import { signInAs, TEST_PASSWORD } from '../support/session.js';

/**
 * `GET /files/:token` serves whatever the registry of file resources holds (design 5.6 and S4.00,
 * task 4.4). The documents module registers `document_download`; here a probe module registers
 * `export_download`, the kind the billing track will turn on, and the door behaves for it exactly
 * as it does for a document: bound to the session, once, re-authorized when it is used.
 */

const OBJECT_KEY_OF = new Map<string, string>();
const TEXT = Buffer.from('fecha;importe\n2026-10-17;35000,00\n', 'utf8');

let runtime: DbHandle;
let h: DocumentsHarness;
let app: FastifyInstance;
const wasEnabled = TOKEN_KIND_REGISTRY.export_download.enabled;

/** The module a track would write: a resource for its kind, and a route that issues its links. */
const probe: ModuleWiring = {
  name: 'file-probe',
  create: (context) => {
    const tokens = createActionTokens();
    context.fileResources.register({
      kind: 'export_download',
      audits: [],
      async redeem(tx, input) {
        const redeemed = await tokens.redeem(tx, 'export_download', input.token, {
          sessionId: input.sessionId,
        });
        if (!redeemed) return null;
        // Re-authorized when used: only an owner may have an export in this probe.
        if (!input.actor.roles.includes('owner')) {
          throw new FileRefused('export_not_readable', 'export', {
            resourceId: redeemed.subjectId,
          });
        }
        const objectKey = OBJECT_KEY_OF.get(redeemed.subjectId);
        if (!objectKey) return null;
        return {
          objectKey,
          contentType: 'text/csv; charset=utf-8',
          contentDisposition: 'attachment; filename="cobros.csv"',
        };
      },
    });
    return {
      routes: (server) => {
        server.post(
          '/probe/export-link',
          { config: { readOnly: 'read', permission: 'patients.read', audits: 'none' } },
          async (request) => {
            const actor = request.actor;
            const session = request.session;
            if (!actor || !session) throw new AppError('unauthenticated');
            const exportId = randomUUID();
            const objectKey = `t/${actor.tenantId}/exports/${exportId}`;
            await h.storage.put(actor.tenantId, objectKey, {
              body: TEXT,
              contentType: 'text/csv',
            });
            OBJECT_KEY_OF.set(exportId, objectKey);
            const issued = await context.withTenant(
              { tenantId: actor.tenantId, userId: actor.userId, actingProfessionalId: null },
              (tx) =>
                tokens.issue(tx, {
                  kind: 'export_download',
                  subjectId: exportId,
                  sessionId: session.sessionId,
                }),
            );
            return { url: `/files/${issued.token}` };
          },
        );
      },
    };
  },
};

beforeAll(async () => {
  TOKEN_KIND_REGISTRY.export_download.enabled = true;
  runtime = createRuntimeDb(inject('runtimeUrl'));
  h = await createDocumentsHarness(runtime, 'file-resources', {
    // Billing registers the real resource of `export_download` (S4.05): the probe stands in for it.
    wiring: [...MODULE_WIRINGS.filter((module) => module.name !== 'billing'), probe],
  });
  app = h.app;
});

afterAll(async () => {
  TOKEN_KIND_REGISTRY.export_download.enabled = wasEnabled;
  await h.close();
  await runtime.close();
});

const link = async (session: DocumentsHarness['sessions']['owner']) => {
  const response = await h.api.post('/probe/export-link', session);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ url: string }>().url;
};

async function denialsBecause(reason: string) {
  const rows = await asSystem(runtime, h.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, h.tenant.id), eq(auditEvent.action, 'access.denied'))),
  );
  return rows.filter((row) => row.reason === reason);
}

describe('a file of another resource, through the same door', () => {
  it('serves the file with the headers its resource chose', async () => {
    const url = await link(h.sessions.owner);

    const response = await h.api.get(url, h.sessions.owner);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.rawPayload.equals(TEXT)).toBe(true);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe('attachment; filename="cobros.csv"');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('works once, like a document link', async () => {
    const url = await link(h.sessions.owner);

    expect((await h.api.get(url, h.sessions.owner)).statusCode).toBe(200);
    expect((await h.api.get(url, h.sessions.owner)).statusCode).toBe(403);
  });

  it('is useless to another session, even the same person in a new one', async () => {
    const url = await link(h.sessions.owner);
    const elsewhere = await signInAs(h.app, h.tenant.slug, h.sessions.owner.user, TEST_PASSWORD);
    const before = (await denialsBecause('file_link_invalid')).length;

    expect((await h.api.get(url, elsewhere)).statusCode).toBe(403);
    expect((await h.api.get(url, h.sessions.admin)).statusCode).toBe(403);
    expect((await denialsBecause('file_link_invalid')).length).toBe(before + 2);
    // Neither attempt spent it: its owner can still use it.
    expect((await h.api.get(url, h.sessions.owner)).statusCode).toBe(200);
  });

  it('is authorized again when used: the answer is the uniform 403, with the deny entry naming the file', async () => {
    const url = await link(h.sessions.reception);

    const response = await h.api.get(url, h.sessions.reception);

    expect(response.statusCode).toBe(403);
    const [entry] = await denialsBecause('export_not_readable');
    expect(entry).toMatchObject({ resourceType: 'export' });
    expect(entry?.resourceId).toEqual(expect.any(String));
  });

  it('needs a session, and answers a link nobody issued like any bad link', async () => {
    const url = await link(h.sessions.owner);
    const junk = await h.api.get(`/files/${'A'.repeat(43)}`, h.sessions.owner);
    const notAToken = await h.api.get('/files/not-a-token', h.sessions.owner);

    expect((await h.api.get(url, null)).statusCode).toBe(401);
    expect(junk.statusCode).toBe(403);
    expect(notAToken.statusCode).toBe(403);
    expect(junk.json()).toEqual({
      ...notAToken.json(),
      requestId: junk.json<{ requestId: string }>().requestId,
    });
  });

  it('is not answered to HEAD, so a link checker cannot spend its one use', async () => {
    const url = await link(h.sessions.owner);

    const head = await app.inject({
      method: 'HEAD',
      url,
      headers: browserHeaders(h.tenant.slug, h.sessions.owner.cookie),
    });

    expect(head.statusCode).toBe(404);
    expect((await h.api.get(url, h.sessions.owner)).statusCode).toBe(200);
  });
});

describe('the registry of an application', () => {
  it('refuses a module that registers a kind the documents module already serves', async () => {
    const duplicate: ModuleWiring = {
      name: 'duplicate',
      create: (context) => {
        context.fileResources.register({
          kind: 'document_download',
          audits: [],
          redeem: () => Promise.resolve(null),
        });
        return {};
      },
    };

    await expect(
      createDocumentsHarness(runtime, 'file-resources-dup', { wiring: [duplicate] }),
    ).rejects.toThrow(/document_download/);
  });
});
