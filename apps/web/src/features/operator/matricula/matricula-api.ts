import {
  MatriculaQueueResponse,
  OperatorMatriculaDto,
  type MatriculaNoteRequest,
  type MatriculaUnverifyRequest,
  type MatriculaVerifyRequest,
  type OperatorMatriculaStatus,
} from '@consultorio/contracts';

import type { ApiClient } from '../../../shared/lib/api-client.js';

export const matriculaKeys = {
  all: ['operator', 'matricula'] as const,
  queue: (status: OperatorMatriculaStatus) => ['operator', 'matricula', 'queue', status] as const,
};

const professionalPath = (tenantId: string, professionalId: string) =>
  `/operator/tenants/${tenantId}/professionals/${professionalId}/matricula`;

/** The matricula verification API of the platform console. Only the platform host answers it. */
export function matriculaApi(api: ApiClient) {
  return {
    queue: async (status: OperatorMatriculaStatus) =>
      (
        await api.get('/operator/matricula-queue', {
          query: { status },
          schema: MatriculaQueueResponse,
        })
      ).items,
    verify: (tenantId: string, professionalId: string, body: MatriculaVerifyRequest) =>
      api.post(`${professionalPath(tenantId, professionalId)}/verify`, {
        body,
        schema: OperatorMatriculaDto,
      }),
    unverify: (tenantId: string, professionalId: string, body: MatriculaUnverifyRequest) =>
      api.post(`${professionalPath(tenantId, professionalId)}/unverify`, {
        body,
        schema: OperatorMatriculaDto,
      }),
    saveNote: (tenantId: string, professionalId: string, body: MatriculaNoteRequest) =>
      api.put(`${professionalPath(tenantId, professionalId)}/note`, {
        body,
        schema: OperatorMatriculaDto,
      }),
  };
}
