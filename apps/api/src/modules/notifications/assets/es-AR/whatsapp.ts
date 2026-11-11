/**
 * The WhatsApp templates (es-AR). WhatsApp only delivers a message that follows a template the
 * provider approved, so the list is closed: the sender refuses a key that is not here, and the
 * local simulator shows the body below as the patient would read it. A template never carries
 * clinical content and never names the organization literally: `organization` is a variable.
 */

export const WHATSAPP_TEMPLATE_KEYS = [
  'appointment_reminder',
  'appointment_confirmation',
  'waitlist_offer',
  /** The follow-up with the video link, after a reminder that said it would be sent separately. */
  'video_link',
  /** The single reply to an opt-out keyword. */
  'optout_ack',
  /** The reply to an opt-out keyword written from a number that several patients share. */
  'optout_ack_shared',
  /** The reply to a "2" that came too late to cancel by WhatsApp: reception takes it from there. */
  'cancel_closed',
] as const;
export type WhatsAppTemplateKey = (typeof WHATSAPP_TEMPLATE_KEYS)[number];

export function isApprovedTemplate(key: string): key is WhatsAppTemplateKey {
  return WHATSAPP_TEMPLATE_KEYS.some((approved) => approved === key);
}

type Vars = Readonly<Record<string, string>>;

function appointmentLines(vars: Vars): string {
  const lines = [`Fecha: ${vars['date'] ?? ''}`, `Hora: ${vars['time'] ?? ''}`];
  lines.push(`Lugar: ${vars['place'] ?? ''}`);
  if (vars['mode'] !== undefined) lines.push(`Modalidad: ${vars['mode']}`);
  if (vars['professional'] !== undefined) lines.push(`Profesional: ${vars['professional']}`);
  if (vars['type'] !== undefined) lines.push(`Tipo de turno: ${vars['type']}`);
  return lines.join('\n');
}

/** How to get into the video call, or that the link follows; nothing for an in-person appointment. */
function videoLine(vars: Vars): string[] {
  if (vars['mode'] === undefined) return [];
  const url = vars['joinUrl'];
  return [
    url === undefined
      ? 'El enlace de la videollamada se enviará por separado.'
      : `Para conectarse, abra este enlace unos minutos antes del turno: ${url}`,
  ];
}

/** How to take an offer: the single-use address, and until when it is open. */
function offerLines(vars: Vars): string[] {
  const url = vars['offerUrl'];
  if (url === undefined) return [];
  const until = vars['offerExpires'];
  return [
    until === undefined
      ? `Para aceptarlo o rechazarlo, abra este enlace: ${url}`
      : `Para aceptarlo o rechazarlo, abra este enlace antes de las ${until}: ${url}`,
  ];
}

const BODIES: Record<WhatsAppTemplateKey, (vars: Vars) => string> = {
  appointment_reminder: (vars) =>
    [
      `Hola ${vars['name'] ?? ''}, le recordamos su turno en ${vars['organization'] ?? ''}.`,
      appointmentLines(vars),
      ...videoLine(vars),
      'Responda 1 para confirmar o 2 para cancelar. Responda BAJA para dejar de recibir estos mensajes.',
    ].join('\n\n'),
  appointment_confirmation: (vars) =>
    [
      `Hola ${vars['name'] ?? ''}, registramos su turno en ${vars['organization'] ?? ''}.`,
      appointmentLines(vars),
      ...videoLine(vars),
      'Responda 2 si necesita cancelarlo. Responda BAJA para dejar de recibir estos mensajes.',
    ].join('\n\n'),
  waitlist_offer: (vars) =>
    [
      `Hola ${vars['name'] ?? ''}, hay un turno disponible en ${vars['organization'] ?? ''}.`,
      appointmentLines(vars),
      ...offerLines(vars),
      'Responda BAJA para dejar de recibir estos mensajes.',
    ].join('\n\n'),
  video_link: (vars) =>
    [
      `Hola ${vars['name'] ?? ''}, este es el enlace de su videoconsulta en ${vars['organization'] ?? ''}.`,
      appointmentLines(vars),
      ...videoLine(vars),
      'Responda BAJA para dejar de recibir estos mensajes.',
    ].join('\n\n'),
  optout_ack: (vars) =>
    `Listo: ${vars['organization'] ?? 'la organización'} no le enviará más mensajes por WhatsApp ni por email. Si cambia de opinión, avise en la recepción.`,
  optout_ack_shared: (vars) =>
    [
      `Listo: ${vars['organization'] ?? 'la organización'} no enviará más mensajes por WhatsApp a este número.`,
      vars['emailPending'] === undefined
        ? 'A quien respondió tampoco le enviará mensajes por email.'
        : 'La recepción confirmará si también corresponde dejar de enviar mensajes por email.',
      'Si cambia de opinión, avise en la recepción.',
    ].join(' '),
  cancel_closed: (vars) =>
    `No pudimos cancelar su turno por este medio porque falta muy poco. Comuníquese con ${vars['organization'] ?? 'la organización'} para cancelarlo o cambiarlo.`,
};

/** The text of a template filled with its variables, as the patient reads it. */
export function whatsappBody(key: WhatsAppTemplateKey, vars: Vars): string {
  return BODIES[key](vars);
}
