import {
  ArchiveOverviewResponse,
  ArchiveReleaseListResponse,
  ArchiveReleaseRequestDto,
  RecordArchiveReleaseRequest,
  RejectArchiveReleaseRequest,
  VerifyArchiveReleaseIdentityRequest,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { operatorOf, platformAuditMetaOf } from '../../../operator/index.js';
import type { ReleaseRequests } from '../release-requests.js';

const Params = z.strictObject({ id: z.uuid() });

/**
 * The operator's routes of the break-glass release (tasks 6.41): record a request, verify the identity
 * of the requester out of band, approve (a different operator), reject, and see the state of the
 * archives. They are registered inside the operator console, behind its session, and none of them
 * returns anything from the archive: a request is a requester and a scope, an archive is counts.
 */
export function releaseRoutes(deps: { releases: ReleaseRequests }) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/operator/archive-releases',
      {
        config: { readOnly: 'read', auth: 'public', operatorAuth: 'session' },
        schema: { response: { 200: ArchiveReleaseListResponse } },
      },
      (request) => deps.releases.list(operatorOf(request)),
    );

    typed.post(
      '/operator/archive-releases',
      {
        config: { readOnly: 'write', auth: 'public', operatorAuth: 'session' },
        schema: { body: RecordArchiveReleaseRequest, response: { 201: ArchiveReleaseRequestDto } },
      },
      async (request, reply) => {
        const created = await deps.releases.record(
          request.body,
          operatorOf(request),
          platformAuditMetaOf(request),
        );
        return reply.code(201).send(created);
      },
    );

    typed.post(
      '/operator/archive-releases/:id/verify-identity',
      {
        config: { readOnly: 'write', auth: 'public', operatorAuth: 'session' },
        schema: {
          params: Params,
          body: VerifyArchiveReleaseIdentityRequest,
          response: { 200: ArchiveReleaseRequestDto },
        },
      },
      (request) =>
        deps.releases.verifyIdentity(
          request.params.id,
          request.body,
          operatorOf(request),
          platformAuditMetaOf(request),
        ),
    );

    typed.post(
      '/operator/archive-releases/:id/approve',
      {
        config: { readOnly: 'write', auth: 'public', operatorAuth: 'session' },
        schema: { params: Params, response: { 200: ArchiveReleaseRequestDto } },
      },
      (request) =>
        deps.releases.approve(request.params.id, operatorOf(request), platformAuditMetaOf(request)),
    );

    typed.post(
      '/operator/archive-releases/:id/reject',
      {
        config: { readOnly: 'write', auth: 'public', operatorAuth: 'session' },
        schema: {
          params: Params,
          body: RejectArchiveReleaseRequest,
          response: { 200: ArchiveReleaseRequestDto },
        },
      },
      (request) =>
        deps.releases.reject(
          request.params.id,
          request.body.reason,
          operatorOf(request),
          platformAuditMetaOf(request),
        ),
    );

    typed.get(
      '/operator/archives',
      {
        config: { readOnly: 'read', auth: 'public', operatorAuth: 'session' },
        schema: { response: { 200: ArchiveOverviewResponse } },
      },
      () => deps.releases.archives(),
    );
  };
}
