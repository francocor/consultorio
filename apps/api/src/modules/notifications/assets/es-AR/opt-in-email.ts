/**
 * The email that asks a patient to accept reminders by WhatsApp (es-AR). WhatsApp can only be
 * switched on by the patient, and this link is how a patient does it when reception cannot hear
 * them say yes in person. It carries no appointment and no clinical data.
 */

export interface OptInRequestInput {
  organizationName: string;
  /** The first of the patient's given names. */
  patientName: string;
  link: string;
  expiresInDays: number;
}

export function renderOptInRequestEmail(input: OptInRequestInput): {
  subject: string;
  text: string;
} {
  return {
    subject: `Recordatorios de turnos por WhatsApp en ${input.organizationName}`,
    text: [
      `Hola ${input.patientName}:`,
      '',
      `${input.organizationName} puede enviarle por WhatsApp los recordatorios y las confirmaciones de sus turnos.`,
      'Si quiere recibirlos, abra este enlace y acepte:',
      input.link,
      '',
      `El enlace sirve una sola vez y vence en ${String(input.expiresInDays)} días.`,
      'Podrá dejar de recibirlos cuando quiera respondiendo BAJA a cualquiera de los mensajes.',
      '',
      'Si no pidió esto, ignore este mensaje: no cambiamos nada.',
    ].join('\n'),
  };
}
