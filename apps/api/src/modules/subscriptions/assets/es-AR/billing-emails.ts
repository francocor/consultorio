import { formatArs, money } from '@consultorio/contracts';

import { BILLING_ZONE } from '../../domain/periods.js';

/**
 * The emails the owner receives about the subscription (subscriptions, "Failed payment and dunning",
 * "Language and communication"): es-AR, amounts in ARS, and nothing about any patient or any record.
 * They are sent to the owner only, by email (never by WhatsApp), and always say the date on which
 * the account becomes read-only, because that is what the owner needs to act before.
 */

export interface BillingEmail {
  subject: string;
  text: string;
}

interface Common {
  organizationName: string;
  /** The screen where the owner pays or reviews: `<organization>/subscription`. */
  link: string;
  /** The payments provider is a simulator: the email says so. */
  simulated?: boolean;
}

/** `28 de octubre de 2026`, the day in the billing zone. */
export function describeDate(instant: Date): string {
  return new Intl.DateTimeFormat('es-AR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: BILLING_ZONE,
  }).format(instant);
}

const SIMULATED_NOTE =
  'Este aviso proviene de un entorno de prueba: el pago es simulado y no se cobró dinero real.';

function closing(common: Common): string[] {
  return [
    '',
    `Puede revisar la suscripción y pagar desde ${common.link}`,
    ...(common.simulated === true ? ['', SIMULATED_NOTE] : []),
    '',
    'Este mensaje es solo para el titular de la cuenta y no contiene datos de pacientes.',
  ];
}

export function renderPastDueEmail(
  input: Common & {
    cause: 'payment_failed' | 'trial_ended';
    graceEndsAt: Date;
    amountCents: number | null;
  },
): BillingEmail {
  const deadline = describeDate(input.graceEndsAt);
  const amount = input.amountCents === null ? '' : ` por ${formatArs(money(input.amountCents))}`;
  const opening =
    input.cause === 'trial_ended'
      ? `Terminó el período de prueba de ${input.organizationName} y todavía no hay una suscripción activa.`
      : `No pudimos cobrar la suscripción de ${input.organizationName}${amount}.`;
  return {
    subject:
      input.cause === 'trial_ended'
        ? 'Terminó su período de prueba'
        : 'No pudimos cobrar su suscripción',
    text: [
      opening,
      '',
      `Todas las funciones siguen disponibles hasta el ${deadline}. Ese día la cuenta pasa a solo lectura: se podrán consultar los registros y exportarlos, pero no cargar datos nuevos ni enviar mensajes.`,
      'Si regulariza el pago antes, la cuenta sigue funcionando con normalidad.',
      ...closing(input),
    ].join('\n'),
  };
}

export function renderDunningEmail(
  input: Common & { day: 1 | 3 | 5; graceEndsAt: Date; amountCents: number | null },
): BillingEmail {
  const deadline = describeDate(input.graceEndsAt);
  const amount = input.amountCents === null ? '' : ` por ${formatArs(money(input.amountCents))}`;
  return {
    subject: 'Todavía no pudimos cobrar su suscripción',
    text: [
      `Seguimos sin poder cobrar la suscripción de ${input.organizationName}${amount}. Pasaron ${String(input.day)} ${input.day === 1 ? 'día' : 'días'} desde el primer intento.`,
      '',
      `La cuenta pasa a solo lectura el ${deadline} si el pago no se regulariza.`,
      ...closing(input),
    ].join('\n'),
  };
}

export function renderReadOnlyEmail(input: Common): BillingEmail {
  return {
    subject: 'Su cuenta pasó a solo lectura',
    text: [
      `Venció el plazo para regularizar el pago de ${input.organizationName} y la cuenta pasó a solo lectura.`,
      '',
      'Los registros siguen disponibles para consulta y se pueden exportar en cualquier momento. No se pueden cargar datos nuevos ni enviar mensajes hasta que el pago se regularice.',
      'Cuando recibamos el pago, la cuenta vuelve a funcionar sola, sin perder nada.',
      ...closing(input),
    ].join('\n'),
  };
}

export function renderRecoveredEmail(input: Common): BillingEmail {
  return {
    subject: 'Recibimos su pago',
    text: [
      `Recibimos el pago de la suscripción de ${input.organizationName}. La cuenta volvió a funcionar con normalidad.`,
      '',
      'Lo que se intentó hacer mientras la cuenta estaba en solo lectura no se repite solo, y los mensajes que quedaron pendientes en ese período no se envían.',
      ...closing(input),
    ].join('\n'),
  };
}
