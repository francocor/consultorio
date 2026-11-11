import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';

import { createPortalSessions } from '../../src/modules/portal/application/sessions.js';
import type { Tx } from '../../src/platform/db/tenant-context.js';
import { portalCookieName } from '../../src/platform/http/portal-session.js';

import { hostOf } from './app.js';

/** A browser signed in to the portal of one organization. */
export interface PortalClient {
  identityId: string;
  linkId: string;
  patientId: string;
  email: string;
  cookie: string;
  get(url: string): Promise<LightMyRequestResponse>;
  post(url: string, payload?: unknown): Promise<LightMyRequestResponse>;
  patch(url: string, payload?: unknown): Promise<LightMyRequestResponse>;
  delete(url: string): Promise<LightMyRequestResponse>;
}

/**
 * A portal session for a patient of an organization, made straight in the database: an active
 * identity, its self link and a session, with no code and no email. For the tests of what a session
 * can read, in worlds that are not the portal's own (invoices, prescriptions): the sign-in has its
 * own tests. The client talks to the real application the way a browser does.
 */
export async function openPortalSession(
  world: {
    app: FastifyInstance;
    slug: string;
    inTenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
    tenant: { id: string };
  },
  patientId: string,
  options: { email?: string; ip?: string } = {},
): Promise<PortalClient> {
  const email = options.email ?? `p${randomUUID().slice(0, 8)}@example.test`;
  const sessions = createPortalSessions();
  const created = await world.inTenant(async (tx) => {
    const identity = await tx.execute<{ id: string }>(
      sql`INSERT INTO portal_identity (tenant_id, email, status, activated_at)
            VALUES (${world.tenant.id}, ${email}, 'active', now()) RETURNING id`,
    );
    const identityId = identity.rows[0]?.id ?? '';
    const link = await tx.execute<{ id: string }>(
      sql`INSERT INTO portal_link (tenant_id, portal_identity_id, patient_id, relationship)
            VALUES (${world.tenant.id}, ${identityId}, ${patientId}, 'self') RETURNING id`,
    );
    const linkId = link.rows[0]?.id ?? '';
    const issued = await sessions.issue(tx, {
      identityId,
      selectedLinkId: linkId,
      now: new Date(),
      ip: null,
      userAgent: 'vitest-portal',
    });
    return { identityId, linkId, token: issued.token };
  });

  const cookie = `${portalCookieName(true)}=${created.token}`;
  const send = (
    method: NonNullable<InjectOptions['method']>,
    url: string,
    payload?: unknown,
  ): Promise<LightMyRequestResponse> =>
    world.app.inject({
      method,
      url,
      headers: {
        host: hostOf(world.slug),
        origin: `https://${hostOf(world.slug)}`,
        'user-agent': 'vitest-portal',
        cookie,
      },
      remoteAddress: options.ip ?? '10.88.0.1',
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  return {
    identityId: created.identityId,
    linkId: created.linkId,
    patientId,
    email,
    cookie,
    get: (url) => send('GET', url),
    post: (url, payload) => send('POST', url, payload ?? {}),
    patch: (url, payload) => send('PATCH', url, payload),
    delete: (url) => send('DELETE', url),
  };
}
