import type {
  AppointmentConsentStatusDto,
  ConsentRequirementsResponse,
  SetConsentRequirementRequest,
} from '@consultorio/contracts';
import { asc, eq } from 'drizzle-orm';

import { consentTemplate } from '../../../db/schema/consent.js';
import { appointmentType } from '../../../db/schema/scheduling-config.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { readAppointmentForCharge } from '../../scheduling/index.js';

import { consentStateFor } from './read-model.js';

export interface AppointmentConsentService {
  /**
   * Whether the appointment needs a consent and whether the patient holds a valid one. It names the
   * template by id only: the warning on an appointment carries no title (it is patient-linked).
   */
  statusOf(tx: Tx, appointmentId: string): Promise<AppointmentConsentStatusDto>;
  /** The appointment types and the consent each requires. */
  requirements(tx: Tx): Promise<ConsentRequirementsResponse>;
  /** Sets, or clears, the consent an appointment type requires. */
  setRequirement(
    tx: Tx,
    input: {
      actor: AuditActor & { userId: string };
      appointmentTypeId: string;
      request: SetConsentRequirementRequest;
    },
  ): Promise<ConsentRequirementsResponse['requirements'][number]>;
}

/**
 * The warning on appointments whose type requires a consent (informed-consent, "Revocation": the
 * system MUST warn professionals when a procedure requires a valid consent that is revoked; task
 * 5.14). The requirement lives on `appointment_type.requires_consent_template_id`, an expand column
 * of the consent track: scheduling neither sets nor reads it.
 */
export function createAppointmentConsentService(): AppointmentConsentService {
  async function typeRow(tx: Tx, appointmentTypeId: string) {
    const [row] = await tx
      .select({
        id: appointmentType.id,
        name: appointmentType.name,
        templateId: appointmentType.requiresConsentTemplateId,
      })
      .from(appointmentType)
      .where(eq(appointmentType.id, appointmentTypeId));
    if (!row) throw new AppError('not_found');
    return row;
  }

  return {
    async statusOf(tx, appointmentId) {
      const appointment = await readAppointmentForCharge(tx, appointmentId);
      if (!appointment) throw new AppError('not_found');
      const type = await typeRow(tx, appointment.appointmentTypeId);
      if (type.templateId === null) {
        return { appointmentId, state: 'not_required', templateId: null };
      }
      const state = await consentStateFor(tx, appointment.patientId, type.templateId);
      return {
        appointmentId,
        state: state === 'valid' ? 'valid' : state === 'revoked' ? 'revoked' : 'missing',
        templateId: type.templateId,
      };
    },

    async requirements(tx) {
      const rows = await tx
        .select({
          appointmentTypeId: appointmentType.id,
          appointmentTypeName: appointmentType.name,
          templateId: appointmentType.requiresConsentTemplateId,
        })
        .from(appointmentType)
        .where(eq(appointmentType.active, true))
        .orderBy(asc(appointmentType.name), asc(appointmentType.id));
      return { requirements: rows };
    },

    async setRequirement(tx, { actor, appointmentTypeId, request }) {
      const type = await typeRow(tx, appointmentTypeId);
      if (request.templateId !== null) {
        const [template] = await tx
          .select({ id: consentTemplate.id, status: consentTemplate.status })
          .from(consentTemplate)
          .where(eq(consentTemplate.id, request.templateId));
        if (!template) throw new AppError('not_found');
        if (template.status === 'retired') throw new AppError('consent_template_retired');
      }
      await tx
        .update(appointmentType)
        .set({ requiresConsentTemplateId: request.templateId })
        .where(eq(appointmentType.id, type.id));
      await audit(tx, {
        action: 'setting.changed',
        outcome: 'allow',
        actor,
        resourceType: 'appointment_type',
        resourceId: type.id,
        metadata: { setting: 'consent_requirement', required: request.templateId !== null },
      });
      return {
        appointmentTypeId: type.id,
        appointmentTypeName: type.name,
        templateId: request.templateId,
      };
    },
  };
}
