/**
 * The email that tells an owner a professional's monthly WhatsApp quota is nearly or fully used
 * (es-AR). Counts only: it names no patient and no message.
 */

export interface UsageAlertInput {
  organizationName: string;
  /** Null when the member has no display name. */
  professionalName: string | null;
  threshold: 80 | 100;
  count: number;
  limit: number;
  /** `YYYY-MM`. */
  period: string;
}

export function renderUsageAlertEmail(input: UsageAlertInput): { subject: string; text: string } {
  const who = input.professionalName ?? 'Un profesional';
  const used = `${String(input.count)} de ${String(input.limit)}`;
  if (input.threshold === 80) {
    return {
      subject: `Uso de WhatsApp: ${who} llegó al 80% del cupo mensual`,
      text: [
        `${who} usó ${used} mensajes de WhatsApp del cupo de ${input.period} en ${input.organizationName}.`,
        '',
        'Al llegar al cupo, los recordatorios siguen según el plan de la organización: se envían por email o se facturan como adicionales.',
        'Puede ver el detalle en Configuración, Mensajes.',
      ].join('\n'),
    };
  }
  return {
    subject: `Uso de WhatsApp: ${who} agotó el cupo mensual`,
    text: [
      `${who} agotó el cupo de mensajes de WhatsApp de ${input.period} en ${input.organizationName} (${used}).`,
      '',
      'Los próximos recordatorios de este profesional siguen según el plan de la organización: se envían por email o se facturan como adicionales.',
      'Puede ver el detalle en Configuración, Mensajes.',
    ].join('\n'),
  };
}
