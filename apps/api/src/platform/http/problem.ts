import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Media type of RFC 9457 problem details. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export interface ProblemBody {
  type: 'about:blank';
  title: string;
  status: number;
  requestId: string;
}

/** Generates the id attached to every request, log line and problem response. */
export function generateRequestId(): string {
  return randomUUID();
}

/** Keeps only the `at ...` lines of a stack: the first line of a V8 stack repeats the message. */
function stackFrames(stack: string | undefined): string[] {
  return (stack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '));
}

function sendProblem(request: FastifyRequest, reply: FastifyReply, status: number): FastifyReply {
  const body: ProblemBody = {
    type: 'about:blank',
    title: STATUS_CODES[status] ?? 'Error',
    status,
    requestId: request.id,
  };
  return reply.code(status).type(PROBLEM_CONTENT_TYPE).send(body);
}

/**
 * Registers the 404 and error handlers.
 *
 * Responses are RFC 9457 problem+json carrying the request id. The title comes from the HTTP status
 * phrase only: `error.message` is never sent to the client, because messages from drivers and
 * validators may contain data. The server-side log keeps the error name, code and stack frames, but
 * not the message, for the same reason.
 */
export function registerProblemHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => sendProblem(request, reply, 404));

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status =
      typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;

    const failure = { name: error.name, code: error.code, frames: stackFrames(error.stack) };
    if (status >= 500) {
      request.log.error({ failure }, 'request failed');
    } else {
      request.log.info({ failure: { name: error.name, code: error.code } }, 'request rejected');
    }

    return sendProblem(request, reply, status);
  });
}
