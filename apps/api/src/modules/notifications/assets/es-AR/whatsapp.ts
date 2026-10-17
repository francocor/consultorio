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
  /** The single reply to an opt-out keyword. */
  'optout_ack',
] as const;
export type WhatsAppTemplateKey = (typeof WHATSAPP_TEMPLATE_KEYS)[number];

export function isApprovedTemplate(key: string): key is WhatsAppTemplateKey {
  return WHATSAPP_TEMPLATE_KEYS.some((approved) => approved === key);
}

type Vars = Readonly<Record<string, string>>;

function appointmentLines(vars: Vars): string {
  const lines = [`Fecha: ${vars['date'] ?? ''}`, `Hora: ${vars['time'] ?? ''}`];
  lines.push(`Lugar: ${vars['place'] ?? ''}`);
  if (vars['professional'] !== undefined) lines.push(`Profesional: ${vars['professional']}`);
  if (vars['type'] !== undefined) lines.push(`Tipo de turno: ${vars['type']}`);
  return lines.join('\n');
}

const BODIES: Record<WhatsAppTemplateKey, (vars: Vars) => string> = {
  appointment_reminder: (vars) =>
    [
      `Hola ${vars['name'] ?? ''}, le recordamos su turno en ${vars['organization'] ?? ''}.`,
      appointmentLines(vars),
      'Responda 1 para confirmar o 2 para cancelar. Responda BAJA para dejar de recibir estos mensajes.',
    ].join('\n\n'),
  appointment_confirmation: (vars) =>
    [
      `Hola ${vars['name'] ?? ''}, registramos su turno en ${vars['organization'] ?? ''}.`,
      appointmentLines(vars),
      'Responda 2 si necesita cancelarlo. Responda BAJA para dejar de recibir estos mensajes.',
    ].join('\n\n'),
  waitlist_offer: (vars) =>
    [
      `Hola ${vars['name'] ?? ''}, hay un turno disponible en ${vars['organization'] ?? ''}.`,
      appointmentLines(vars),
      'Responda BAJA para dejar de recibir estos mensajes.',
    ].join('\n\n'),
  optout_ack: () =>
    'Listo: no le enviaremos más mensajes por WhatsApp. Si cambia de opinión, avise en la recepción.',
};

/** The text of a template filled with its variables, as the patient reads it. */
export function whatsappBody(key: WhatsAppTemplateKey, vars: Vars): string {
  return BODIES[key](vars);
}
