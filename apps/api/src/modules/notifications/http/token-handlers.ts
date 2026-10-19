import type {
  TokenContext,
  TokenHandler,
  TokenPage,
} from '../../../platform/public/token-router.js';
import { readPatientContact } from '../../patients/index.js';
import { loadAppointment, type AppointmentContext } from '../application/context.js';
import type { Worklist } from '../application/deps.js';
import { optOutPatient } from '../application/opt-out.js';
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
      // The use is spent when the change was made, not before: a change the appointment refuses
      // leaves the link as it was. (A change may revoke the links of the appointment itself, so
      // whether this one is still there to spend does not matter once it was made.)
      if (!(await transition(deps, context, appointment, 'confirm'))) return GONE;
      await context.redeem();
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
      if (!(await transition(deps, context, appointment, 'cancel'))) return GONE;
      // The cancellation revokes the links of the appointment, this one included.
      await context.redeem();
      return {
        title: 'Turno cancelado',
        message:
          'Registramos la cancelación. Si lo necesita, comuníquese con la organización para pedir otro turno.',
      };
    },
  };
}

/**
 * The unsubscribe link of the email footer (owner decision B7): it opts the patient out of ALL
 * channels, and the page says so. The payload of links already sent may still name a channel (they
 * keep working); it no longer changes what the link does.
 */
export function createOptOutHandler(): TokenHandler {
  return {
    allowedWhenReadOnly: true,
    audits: ['notification.optout.recorded'],
    describe() {
      return Promise.resolve({
        title: 'Dejar de recibir mensajes',
        message:
          'No volverá a recibir mensajes de esta organización por ningún canal (email ni WhatsApp): ni recordatorios, ni avisos de turnos, ni ofertas de la lista de espera. Si cambia de opinión, avise en la recepción.',
        action: { label: 'Dejar de recibir mensajes' },
      });
    },
    async perform(context) {
      if (!(await context.redeem())) return null;
      await optOutPatient(context.tx, {
        patientId: context.subjectId,
        source: 'email_link',
        actor: context.actor,
      });
      return {
        title: 'Listo: no recibirá más mensajes',
        message:
          'Dejamos de enviarle mensajes por todos los canales, email y WhatsApp. Si cambia de opinión, avise en la recepción.',
      };
    },
  };
}

/**
 * What a link to accept WhatsApp is about. The link of a public form belongs to the SUBMISSION (its
 * payload remembers the patient and whether that submission created them); the link staff send from
 * a patient's record belongs to the patient.
 */
type OptInTarget =
  | { kind: 'patient'; patientId: string }
  | {
      kind: 'submission';
      patientId: string | null;
      created: boolean;
      appointmentId: string | null;
      locationId: string | null;
    };

function optInTarget(context: TokenContext): OptInTarget {
  const { payload } = context;
  if (!('created' in payload)) return { kind: 'patient', patientId: context.subjectId };
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  return {
    kind: 'submission',
    patientId: text(payload['patientId']),
    created: payload['created'] === true,
    appointmentId: text(payload['appointmentId']),
    locationId: text(payload['locationId']),
  };
}

const OPT_IN_PAGE = {
  title: 'Aceptar recordatorios por WhatsApp',
  message:
    'Recibirá por WhatsApp los recordatorios y las confirmaciones de sus turnos. Podrá dejar de recibirlos cuando quiera respondiendo BAJA a cualquiera de los mensajes.',
  action: { label: 'Aceptar recordatorios por WhatsApp' },
} as const;

const OPT_IN_DONE = {
  title: 'Listo: recibirá recordatorios por WhatsApp',
  message:
    'Puede dejar de recibirlos cuando quiera respondiendo BAJA a cualquiera de los mensajes.',
} as const;

/**
 * The link of the email that asks a patient to accept WhatsApp. It is how the opt-in "by the
 * patient on an email link" is recorded; a WhatsApp message can never do it.
 *
 * The link of a public form exists whoever the document belongs to, so the email never says
 * whether it was on file (judgment day round 2, finding A1). Following it shows the same page and
 * answers the same in every case; what differs is only what is recorded: the opt-in, when that
 * submission created the patient, and otherwise nothing on the record, but a reception item to look
 * at (the number is unverified and the record is somebody's already).
 */
export function createWhatsappOptInHandler(deps: { worklist: Worklist }): TokenHandler {
  return {
    // Opting in is not a protective action: a read-only organization sends no WhatsApp at all.
    allowedWhenReadOnly: false,
    audits: ['notification.optin.recorded'],
    async describe(context) {
      const target = optInTarget(context);
      // A link staff sent is about a patient who must still exist; the link of a form says the same
      // thing whatever became of its submission.
      if (target.kind === 'patient' && !(await readPatientContact(context.tx, target.patientId))) {
        return null;
      }
      return { ...OPT_IN_PAGE };
    },
    async perform(context) {
      const target = optInTarget(context);
      if (target.kind === 'patient') {
        if (!(await readPatientContact(context.tx, target.patientId))) return null;
        if (!(await context.redeem())) return null;
        await recordOptIn(context.tx, {
          patientId: target.patientId,
          channel: 'whatsapp',
          source: 'patient_email_link',
          actor: context.actor,
        });
        return { ...OPT_IN_DONE };
      }
      if (!(await context.redeem())) return null;
      if (target.created && target.patientId !== null) {
        if (await readPatientContact(context.tx, target.patientId)) {
          await recordOptIn(context.tx, {
            patientId: target.patientId,
            channel: 'whatsapp',
            source: 'patient_email_link',
            actor: context.actor,
          });
        }
      } else if (target.appointmentId !== null) {
        // The record is not this submission's: nothing is written on it, and reception looks.
        await deps.worklist.open(context.tx, {
          kind: 'identity_review',
          subjectType: 'appointment',
          subjectId: target.appointmentId,
          locationId: target.locationId,
          detail: { source: 'whatsapp_opt_in_link', whatsappOptInRequested: true },
        });
      }
      return { ...OPT_IN_DONE };
    },
  };
}
