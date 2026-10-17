import { isIP } from 'node:net';

import type { Role } from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AuditActor } from './writer.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Who is acting and from where, for audit entries. Set on every request. */
    auditActor: AuditActor;
  }
}

const MAX_USER_AGENT = 512;
// Control characters have no place in a stored header value (log and audit injection).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

function sanitizeUserAgent(header: string | undefined): string | null {
  const cleaned = (header ?? '').replace(CONTROL_CHARACTERS, '').slice(0, MAX_USER_AGENT);
  return cleaned === '' ? null : cleaned;
}

/**
 * The audit column is an `inet`: a value that is not an IP address (a forged forwarded header, say)
 * would make the insert fail and turn a harmless request into a 500. It is stored as unknown.
 */
function validAddress(address: string | undefined): string | null {
  // A zone id (`fe80::1%eth0`) is a valid IP for Node but not for an `inet` column.
  return address !== undefined && isIP(address) !== 0 && !address.includes('%') ? address : null;
}

/**
 * Fills `request.auditActor` with what is known before authentication: client address, user
 * agent and request id. The address is `request.ip`, which honours `X-Forwarded-For` only when
 * the server was built with `trustProxy` (behind the load balancer), so it cannot be spoofed
 * by a direct client. Authentication later calls `setAuditActor` with the user and the role.
 */
export function registerRequestContext(app: FastifyInstance): void {
  app.decorateRequest('auditActor');

  app.addHook('onRequest', (request, _reply, done) => {
    request.auditActor = {
      userId: null,
      actingRole: null,
      ip: validAddress(request.ip),
      userAgent: sanitizeUserAgent(request.headers['user-agent']),
      requestId: request.id,
    };
    done();
  });
}

/** Called by authentication once the session is known. */
export function setAuditActor(
  request: FastifyRequest,
  actor: { userId: string; actingRole: Role },
): void {
  request.auditActor = { ...request.auditActor, ...actor };
}
