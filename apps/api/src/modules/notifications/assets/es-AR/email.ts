import type { AppointmentMessageKind } from '@consultorio/contracts';

import type { MessageVars, VideoNote } from '../../domain/content.js';

/**
 * The email templates (es-AR) for the three messages of an appointment. The organization is a
 * variable, never a literal. Nothing clinical is ever written here.
 */

export interface EmailLinks {
  /** Confirms the appointment (reminders only). */
  confirmUrl?: string;
  /** Cancels the appointment. */
  cancelUrl?: string;
  /** Accepts a waitlist offer (offers only). */
  offerUrl?: string;
  /** Stops reminders by email for this patient. */
  optOutUrl?: string;
}

export interface EmailParts {
  subject: string;
  /** The lead paragraph, after the greeting. */
  intro: string;
  /** A link that asks the patient to do something, with the sentence that introduces it. */
  actions: { sentence: string; label: string; url: string }[];
}

/** What a message of an appointment says about its video call: the way in, or that it follows. */
function videoParts(video: VideoNote | undefined): {
  action?: EmailParts['actions'][number];
  note?: string;
} {
  if (video === undefined) return {};
  if (video.kind === 'pending') {
    return { note: 'La consulta es por videollamada y le enviaremos el enlace por separado.' };
  }
  return {
    action: {
      sentence:
        'La consulta es por videollamada. Para conectarse, abra este enlace unos minutos antes del turno:',
      label: 'Unirse a la videollamada',
      url: video.url,
    },
  };
}

export function emailParts(
  kind: AppointmentMessageKind,
  vars: MessageVars,
  links: EmailLinks,
  video?: VideoNote,
): EmailParts {
  const parts = appointmentEmailParts(kind, vars, links);
  if (kind === 'waitlist_offer') return parts;
  const { action, note } = videoParts(video);
  return {
    ...parts,
    intro: note === undefined ? parts.intro : `${parts.intro} ${note}`,
    actions: action === undefined ? parts.actions : [action, ...parts.actions],
  };
}

function appointmentEmailParts(
  kind: AppointmentMessageKind,
  vars: MessageVars,
  links: EmailLinks,
): EmailParts {
  const organization = vars.organization;
  switch (kind) {
    case 'reminder': {
      const actions: EmailParts['actions'] = [];
      if (links.confirmUrl !== undefined) {
        actions.push({
          sentence: 'Para confirmar su asistencia, abra este enlace:',
          label: 'Confirmar asistencia',
          url: links.confirmUrl,
        });
      }
      if (links.cancelUrl !== undefined) {
        actions.push({
          sentence: 'Si no puede asistir, puede cancelar el turno desde este enlace:',
          label: 'Cancelar el turno',
          url: links.cancelUrl,
        });
      }
      return {
        subject: `Recordatorio de su turno en ${organization}`,
        intro: `Le recordamos su turno en ${organization}.`,
        actions,
      };
    }
    case 'confirmation': {
      const actions: EmailParts['actions'] = [];
      if (links.cancelUrl !== undefined) {
        actions.push({
          sentence: 'Si no puede asistir, puede cancelar el turno desde este enlace:',
          label: 'Cancelar el turno',
          url: links.cancelUrl,
        });
      }
      return {
        subject: `Su turno en ${organization} está confirmado`,
        intro: `Registramos su turno en ${organization}.`,
        actions,
      };
    }
    case 'waitlist_offer': {
      if (links.offerUrl === undefined) throw new Error('A waitlist offer needs the offer link');
      return {
        subject: `Hay un turno disponible en ${organization}`,
        intro: `Hay un turno disponible en ${organization}, que usted esperaba.`,
        actions: [
          {
            sentence:
              vars.offerExpires === undefined
                ? 'Para aceptarlo o rechazarlo, abra este enlace antes de que venza la oferta:'
                : `Para aceptarlo o rechazarlo, abra este enlace antes de las ${vars.offerExpires}:`,
            label: 'Ver la oferta',
            url: links.offerUrl,
          },
        ],
      };
    }
  }
}

export const OPT_OUT_SENTENCE = 'Para dejar de recibir recordatorios por email, use este enlace:';
export const OPT_OUT_LABEL = 'Dejar de recibir recordatorios';
export const FALLBACK_LINK_NOTE = 'Si el botón no funciona, copie el enlace en su navegador.';
