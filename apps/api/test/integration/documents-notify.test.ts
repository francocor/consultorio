import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFakeEmailSender } from '../../src/adapters/fake-email/index.js';
import { createRejectionNotifier } from '../../src/modules/documents/application/rejection-email.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { SYSTEM_USER_ID } from '../../src/platform/db/tenant-context.js';
import { asSystem } from '../support/documents.js';
import { createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let tenant: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  tenant = await createTestTenant(runtime, { slug: 'docs-notify', isDemo: true });
});

afterAll(async () => {
  await runtime.close();
});

describe('telling the uploader that a file was refused', () => {
  it('emails the uploader, names the organization, and carries nothing about the file', async () => {
    const email = createFakeEmailSender();
    const uploader = await createTestUser(runtime, tenant.id, { roles: ['reception'] });
    const notify = createRejectionNotifier({ email });

    await asSystem(runtime, tenant.id, (tx) =>
      notify(tx, {
        tenantId: tenant.id,
        documentId: randomUUID(),
        uploaderUserId: uploader.id,
        reason: 'infected',
        rejectedAt: new Date(),
      }),
    );

    expect(email.sent).toHaveLength(1);
    const message = email.sent[0];
    expect(message?.to).toBe(uploader.email);
    expect(message?.subject).toBe('Un archivo no pudo cargarse en docs-notify');
    expect(message?.text).toContain('software malicioso');
    // The organization is a demo one, so the routing sender keeps the message off real providers.
    expect(message?.tenant).toEqual({ id: tenant.id, isDemo: true });
  });

  it('does nothing for an uploader who no longer exists, instead of failing the scan', async () => {
    const email = createFakeEmailSender();
    const notify = createRejectionNotifier({ email });

    await asSystem(runtime, tenant.id, (tx) =>
      notify(tx, {
        tenantId: tenant.id,
        documentId: randomUUID(),
        uploaderUserId: SYSTEM_USER_ID,
        reason: 'corrupt',
        rejectedAt: new Date(),
      }),
    );

    expect(email.sent).toHaveLength(0);
  });
});
