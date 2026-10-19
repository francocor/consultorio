import {
  CONSENT_DEFAULT_EXPIRY_DAYS,
  type ConsentRequestDto,
  type CreateConsentRequestRequest,
} from '@consultorio/contracts';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';

import { encounter } from '../../../db/schema/clinical.js';
import {
  consentRequest,
  consentTemplate,
  consentTemplateVersion,
  type ConsentRequestRow,
} from '../../../db/schema/consent.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { readPatientContact } from '../../patients/index.js';
import { readAppointmentForCharge } from '../../scheduling/index.js';

import { requireRequest, tenantId, toRequestDto } from './records.js';

type Auditor = AuditActor & { userId: string };

const DAY_MS = 86_400_000;

export interface RequestService {
  /** Asks a patient for a consent: the request is bound to the latest published version. */
  create(
    tx: Tx,
    input: { actor: Auditor; request: CreateConsentRequestRequest },
  ): Promise<ConsentRequestDto>;
  /**
   * The patient chose not to sign. The request ends declined and cannot be signed. `actor` is who
   * recorded it: the entry of the trail names them.
   */
  decline(tx: Tx, input: { requestId: string; actor: Auditor }): Promise<ConsentRequestDto>;
}

/**
 * Requesting a consent (informed-consent, "Requesting a consent"). The permission to ask is
 * `consent.request` (professional and reception). The request carries the version, never the
 * title: the neutral label is applied by the read model, and the notice that goes by email names no
 * template (see `notice.ts`).
 */
export function createRequestService(deps: { clock: () => Date }): RequestService {
  /**
   * A request that waits past its date counts as ended already (the read model shows it expired),
   * but until the job records it, it would still hold the "one live request" slot. Closing it
   * here lets the staff ask again at once.
   */
  async function closeStale(tx: Tx, patientId: string, templateId: string, actor: Auditor) {
    const now = deps.clock();
    const stale = await tx
      .select({ id: consentRequest.id })
      .from(consentRequest)
      .innerJoin(
        consentTemplateVersion,
        sql`${consentTemplateVersion.tenantId} = ${consentRequest.tenantId}
            and ${consentTemplateVersion.id} = ${consentRequest.templateVersionId}`,
      )
      .where(
        and(
          eq(consentRequest.patientId, patientId),
          eq(consentRequest.status, 'pending'),
          eq(consentTemplateVersion.templateId, templateId),
          lte(consentRequest.expiresAt, now),
        ),
      )
      .for('update', { of: consentRequest });
    if (stale.length === 0) return;
    await tx
      .update(consentRequest)
      .set({ status: 'expired', closedAt: now })
      .where(
        inArray(
          consentRequest.id,
          stale.map((row) => row.id),
        ),
      );
    for (const row of stale) {
      await audit(tx, {
        action: 'consent.expired',
        outcome: 'allow',
        actor,
        resourceType: 'consent_request',
        resourceId: row.id,
        patientId,
        metadata: { via: 'new_request' },
      });
    }
  }

  return {
    async create(tx, { actor, request }) {
      if (!(await readPatientContact(tx, request.patientId))) throw new AppError('not_found');

      const [template] = await tx
        .select()
        .from(consentTemplate)
        .where(eq(consentTemplate.id, request.templateId));
      if (!template) throw new AppError('not_found');
      const [latest] = await tx
        .select()
        .from(consentTemplateVersion)
        .where(eq(consentTemplateVersion.templateId, template.id))
        .orderBy(desc(consentTemplateVersion.versionNumber))
        .limit(1);
      if (template.status !== 'published' || !latest) {
        throw new AppError('consent_template_not_offered');
      }

      if (request.appointmentId !== undefined) {
        const appointment = await readAppointmentForCharge(tx, request.appointmentId);
        if (appointment?.patientId !== request.patientId) throw new AppError('not_found');
      }
      if (request.encounterId !== undefined) {
        // Only a professional's transaction sees encounters: for anyone else this is "not found".
        const [found] = await tx
          .select({ id: encounter.id })
          .from(encounter)
          .where(
            and(eq(encounter.id, request.encounterId), eq(encounter.patientId, request.patientId)),
          );
        if (!found) throw new AppError('not_found');
      }

      await closeStale(tx, request.patientId, template.id, actor);
      const waiting = await tx
        .select({ id: consentRequest.id })
        .from(consentRequest)
        .innerJoin(
          consentTemplateVersion,
          sql`${consentTemplateVersion.tenantId} = ${consentRequest.tenantId}
              and ${consentTemplateVersion.id} = ${consentRequest.templateVersionId}`,
        )
        .where(
          and(
            eq(consentRequest.patientId, request.patientId),
            eq(consentRequest.status, 'pending'),
            eq(consentTemplateVersion.templateId, template.id),
          ),
        )
        .limit(1);
      if (waiting.length > 0) throw new AppError('consent_request_pending');

      const now = deps.clock();
      const days = request.expiresInDays ?? CONSENT_DEFAULT_EXPIRY_DAYS;
      const [row] = await tx
        .insert(consentRequest)
        .values({
          tenantId,
          patientId: request.patientId,
          templateVersionId: latest.id,
          appointmentId: request.appointmentId ?? null,
          encounterId: request.encounterId ?? null,
          method: request.method,
          expiresAt: new Date(now.getTime() + days * DAY_MS),
          requestedBy: actor.userId,
        })
        .returning();
      if (!row) throw new Error('inserting a consent request returned no row');

      await audit(tx, {
        action: 'consent.requested',
        outcome: 'allow',
        actor,
        resourceType: 'consent_request',
        resourceId: row.id,
        patientId: row.patientId,
        // The template is named by id and version, never by its title.
        metadata: {
          templateId: template.id,
          version: latest.versionNumber,
          method: row.method,
          expiresInDays: days,
        },
      });
      return toRequestDto(row, latest, now);
    },

    async decline(tx, { requestId, actor }) {
      const { request, version } = await requireRequest(tx, requestId, { lock: true });
      const now = deps.clock();
      if (request.status !== 'pending') throw new AppError('consent_request_closed');
      if (request.expiresAt.getTime() <= now.getTime())
        throw new AppError('consent_request_expired');
      const [row] = await tx
        .update(consentRequest)
        .set({ status: 'declined', closedAt: now })
        .where(eq(consentRequest.id, request.id))
        .returning();
      // A refusal to sign is a decision about the patient's care that somebody recorded: the trail
      // names who (JD-S5 R1-S5-10), the template by id and version, never by title.
      await audit(tx, {
        action: 'consent.declined',
        outcome: 'allow',
        actor,
        resourceType: 'consent_request',
        resourceId: request.id,
        patientId: request.patientId,
        metadata: {
          templateId: version.templateId,
          version: version.versionNumber,
          method: request.method,
        },
      });
      return toRequestDto(row as ConsentRequestRow, version, now);
    },
  };
}
