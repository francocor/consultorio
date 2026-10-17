import type { MessageChannel } from '@consultorio/contracts';

import type {
  TokenContext,
  TokenHandler,
  TokenPage,
} from '../../../platform/public/token-router.js';
import { readPatientContact } from '../../patients/index.js';
import { loadAppointment, type AppointmentContext } from '../application/context.js';
import { optOutChannel } from '../application/opt-out.js';
import { actForPatient, type PatientActionDeps } from '../application/patient-actions.js';
import { recordOptIn } from '../application/preferences.js';
import { loadMessagingSettings } from '../application/settings.js';
import { formatDate, formatTime } from '../domain/content.js';
import { withinCancelDeadline } from '../domain/validity.js';

/**
 * What the links of a reminder do (spec "Confirmation by the patient", "Opt-out and consent"):
 * confirm the appointment, cancel it, or stop messages on one channel. They plug into the public
 * token router; the patient is never asked to sign in, so a handler shows only the date, time,
 * place and professional of the one appointment the link is about, and acts on that appointment
 * alone.
 */

export type TokenHandlerDeps = PatientActionDeps;

const GONE: TokenPage = {
  title: 'No se pudo completar la acción',
  message: 'El turno cambió. Comuníquese con la organización.',
  status: 409,
};

/** The appointment the link is for, while it can still be acted on. */
async function liveAppointment(context: TokenContext): Promise<AppointmentContext | null> {
  const appointment = await loadAppointment(context.tx, context.subjectId);
  if (!appointment) return null;
  if (appointment.status !== 'scheduled' && appointment.status !== 'confirmed') return null;
  if (appointment.startsAt.getTime() <= context.now.getTime()) return null;
  // The link was issued for one patient: if the appointment went to another record, it is dead.
  const patientId = context.payload['patientId'];
  if (typeof patientId === 'string' && patientId !== appointment.patientId) return null;
  return appointment;
}

async function details(context: TokenContext, appointment: AppointmentContext) {
  const settings = await loadMessagingSettings(context.tx);
  const rows = [
    { label: 'Fecha', value: formatDate(appointment.startsAt, appointment.timeZone) },
    { label: 'Hora', value: formatTime(appointment.startsAt, appointment.timeZone) },
    { label: 'Lugar', value: appointment.locationName },
  ];
  if (!settings.notifications.hideProfessional && appointment.professionalName !== null) {
    rows.push({ label: 'Profesional', value: appointment.professionalName });
  }
  return { rows, settings };
}

function transition(
  deps: TokenHandlerDeps,
  context: TokenContext,
  appointment: AppointmentContext,
  action: 'confirm' | 'cancel',
): Promise<boolean> {
  return actForPatient(deps, context.tx, {
    appointment,
    action,
    now: context.now,
    actor: context.actor,
  });
}

export function createConfirmHandler(deps: TokenHandlerDeps): TokenHandler {
  return {
    allowedWhenReadOnly: false,
    audits: ['appointment.status_changed'],
    async describe(context) {
      const appointment = await liveAppointment(context);
      if (!appointment) return null;
      const { rows } = await details(context, appointment);
      return appointment.status === 'confirmed'
        ? { title: 'Su asistencia ya está confirmada', details: rows }
        : {
            title: 'Confirme su asistencia',
            details: rows,
            action: { label: 'Confirmar asistencia' },
          };
    },
    async perform(context) {
      const appointment = await liveAppointment(context);
      if (!appointment) return null;
      const { rows } = await details(context, appointment);
      if (appointment.status === 'confirmed') {
        return { title: 'Su asistencia ya está confirmada', details: rows };
      }
      if (!(await context.redeem())) return null;
      if (!(await transition(deps, context, appointment, 'confirm'))) return GONE;
      return { title: 'Asistencia confirmada', details: rows, message: 'Gracias. Lo esperamos.' };
    },
  };
}

export function createCancelHandler(deps: TokenHandlerDeps): TokenHandler {
  const closed = (rows: { label: string; value: string }[]): TokenPage => ({
    title: 'El plazo para cancelar por este medio terminó',
    message: 'Comuníquese con la organización para cancelar o modificar su turno.',
    details: rows,
  });
  return {
    // A patient who wants out must always be able to get out, even while the organization is
    // read-only (patient protective).
    allowedWhenReadOnly: true,
    audits: ['appointment.cancelled'],
    async describe(context) {
      const appointment = await liveAppointment(context);
      if (!appointment) return null;
      const { rows, settings } = await details(context, appointment);
      if (
        !withinCancelDeadline({
          now: context.now,
          startsAt: appointment.startsAt,
          deadlineHours: settings.cancelDeadlineHours,
        })
      ) {
        return closed(rows);
      }
      return {
        title: '¿Quiere cancelar el turno?',
        details: rows,
        action: { label: 'Cancelar el turno' },
      };
    },
    async perform(context) {
      const appointment = await liveAppointment(context);
      if (!appointment) return null;
      const { rows, settings } = await details(context, appointment);
      if (
        !withinCancelDeadline({
          now: context.now,
          startsAt: appointment.startsAt,
          deadlineHours: settings.cancelDeadlineHours,
        })
      ) {
        return closed(rows);
      }
      if (!(await context.redeem())) return null;
      if (!(await transition(deps, context, appointment, 'cancel'))) return GONE;
      return {
        title: 'Turno cancelado',
        message:
          'Registramos la cancelación. Si lo necesita, comuníquese con la organización para pedir otro turno.',
      };
    },
  };
}

function channelOf(payload: Record<string, unknown>): MessageChannel {
  return payload['channel'] === 'whatsapp' ? 'whatsapp' : 'email';
}

const CHANNEL_NAME: Record<MessageChannel, string> = { email: 'email', whatsapp: 'WhatsApp' };

export function createOptOutHandler(): TokenHandler {
  return {
    allowedWhenReadOnly: true,
    audits: ['notification.optout.recorded'],
    describe(context) {
      const channel = CHANNEL_NAME[channelOf(context.payload)];
      return Promise.resolve({
        title: `Dejar de recibir mensajes por ${channel}`,
        message: `No volverá a recibir recordatorios ni avisos de turnos por ${channel}. Si cambia de opinión, avise en la recepción.`,
        action: { label: 'Dejar de recibir mensajes' },
      });
    },
    async perform(context) {
      const channel = channelOf(context.payload);
      if (!(await context.redeem())) return null;
      await optOutChannel(context.tx, {
        patientId: context.subjectId,
        channel,
        source: 'email_link',
        actor: context.actor,
      });
      return {
        title: 'Listo: no recibirá más mensajes',
        message: `Dejamos de enviarle mensajes por ${CHANNEL_NAME[channel]}. Si cambia de opinión, avise en la recepción.`,
      };
    },
  };
}

/**
 * The link of the email that asks a patient to accept WhatsApp. It is how the opt-in "by the
 * patient on an email link" is recorded; a WhatsApp message can never do it.
 */
export function createWhatsappOptInHandler(): TokenHandler {
  return {
    // Opting in is not a protective action: a read-only organization sends no WhatsApp at all.
    allowedWhenReadOnly: false,
    audits: ['notification.optin.recorded'],
    async describe(context) {
      if (!(await readPatientContact(context.tx, context.subjectId))) return null;
      return {
        title: 'Aceptar recordatorios por WhatsApp',
        message:
          'Recibirá por WhatsApp los recordatorios y las confirmaciones de sus turnos. Podrá dejar de recibirlos cuando quiera respondiendo BAJA a cualquiera de los mensajes.',
        action: { label: 'Aceptar recordatorios por WhatsApp' },
      };
    },
    async perform(context) {
      if (!(await readPatientContact(context.tx, context.subjectId))) return null;
      if (!(await context.redeem())) return null;
      await recordOptIn(context.tx, {
        patientId: context.subjectId,
        channel: 'whatsapp',
        source: 'patient_email_link',
        actor: context.actor,
      });
      return {
        title: 'Listo: recibirá recordatorios por WhatsApp',
        message:
          'Puede dejar de recibirlos cuando quiera respondiendo BAJA a cualquiera de los mensajes.',
      };
    },
  };
}
