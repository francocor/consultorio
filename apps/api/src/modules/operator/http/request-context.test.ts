import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../../platform/http/problem.js';

import { operatorOf, platformAuditMetaOf } from './request-context.js';

function requestWith(overrides: Record<string, unknown>): FastifyRequest {
  return {
    operator: null,
    auditActor: { ip: '10.0.0.7', userAgent: 'vitest', requestId: 'req-1', userId: 'ignored' },
    ...overrides,
  } as unknown as FastifyRequest;
}

describe('what an operator route reads from its request', () => {
  it('names the operator who is signed in', () => {
    const identity = { id: 'op-1', email: 'ops@platform.example', displayName: 'Ops' };

    expect(operatorOf(requestWith({ operator: { operator: identity } }))).toEqual(identity);
  });

  it('refuses a request with no operator session: a route that forgot its guard fails closed', () => {
    expect(() => operatorOf(requestWith({ operator: null }))).toThrow(AppError);
  });

  it('gives the address, the agent and the request id for the platform trail, and nothing else', () => {
    expect(platformAuditMetaOf(requestWith({}))).toEqual({
      ip: '10.0.0.7',
      userAgent: 'vitest',
      requestId: 'req-1',
    });
  });
});
