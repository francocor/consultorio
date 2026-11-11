import { describe, expect, it } from 'vitest';

import {
  describeDate,
  renderDunningEmail,
  renderPastDueEmail,
  renderReadOnlyEmail,
  renderRecoveredEmail,
} from '../assets/es-AR/billing-emails.js';

import { dueDunningStep } from './clock.js';

const DAY = 86_400_000;
const FIRST = new Date('2026-11-05T15:00:00.000Z');
const after = (days: number, extraMs = 0) => new Date(FIRST.getTime() + days * DAY + extraMs);

describe('the reminders of the grace are owed by the date, never by a message', () => {
  it('owes nothing before the first day, and the first reminder on day 1', () => {
    expect(dueDunningStep({ firstFailureAt: FIRST, done: 0, now: after(0, 3_600_000) })).toBeNull();
    expect(dueDunningStep({ firstFailureAt: FIRST, done: 0, now: after(1, -1) })).toBeNull();
    expect(dueDunningStep({ firstFailureAt: FIRST, done: 0, now: after(1) })).toEqual({
      index: 0,
      day: 1,
    });
  });

  it('owes day 3 and then day 5, each once: a step already done is not owed again', () => {
    expect(dueDunningStep({ firstFailureAt: FIRST, done: 1, now: after(2) })).toBeNull();
    expect(dueDunningStep({ firstFailureAt: FIRST, done: 1, now: after(3) })).toEqual({
      index: 1,
      day: 3,
    });
    expect(dueDunningStep({ firstFailureAt: FIRST, done: 2, now: after(5) })).toEqual({
      index: 2,
      day: 5,
    });
    expect(dueDunningStep({ firstFailureAt: FIRST, done: 3, now: after(6) })).toBeNull();
  });

  it('sends only the latest when a pass was late: one email, not three at once', () => {
    expect(dueDunningStep({ firstFailureAt: FIRST, done: 0, now: after(5, 1000) })).toEqual({
      index: 2,
      day: 5,
    });
  });
});

describe('the emails of the subscription (es-AR, ARS, no patient data)', () => {
  const common = {
    organizationName: 'Centro Médico Aillu',
    link: 'https://aillu.consultorio.test/subscription',
  };
  const grace = new Date('2026-11-12T15:00:00.000Z');

  it('writes a date as a person reads it, in the billing zone', () => {
    expect(describeDate(new Date('2026-11-12T01:30:00.000Z'))).toBe('11 de noviembre de 2026');
    expect(describeDate(grace)).toBe('12 de noviembre de 2026');
  });

  it('tells the owner a charge failed, how much, and the day the account becomes read-only', () => {
    const email = renderPastDueEmail({
      ...common,
      cause: 'payment_failed',
      graceEndsAt: grace,
      amountCents: 3_600_050,
    });

    expect(email.subject).toBe('No pudimos cobrar su suscripción');
    expect(email.text).toBe(
      [
        'No pudimos cobrar la suscripción de Centro Médico Aillu por $ 36.000,50.',
        '',
        'Todas las funciones siguen disponibles hasta el 12 de noviembre de 2026. Ese día la cuenta pasa a solo lectura: se podrán consultar los registros y exportarlos, pero no cargar datos nuevos ni enviar mensajes.',
        'Si regulariza el pago antes, la cuenta sigue funcionando con normalidad.',
        '',
        'Puede revisar la suscripción y pagar desde https://aillu.consultorio.test/subscription',
        '',
        'Este mensaje es solo para el titular de la cuenta y no contiene datos de pacientes.',
      ].join('\n'),
    );
  });

  it('says it is a trial that ended, when it is', () => {
    const email = renderPastDueEmail({
      ...common,
      cause: 'trial_ended',
      graceEndsAt: grace,
      amountCents: null,
    });

    expect(email.subject).toBe('Terminó su período de prueba');
    expect(email.text).toContain('Terminó el período de prueba de Centro Médico Aillu');
    expect(email.text).toContain('12 de noviembre de 2026');
  });

  it('reminds on day 1, 3 and 5 with the number of days in the singular and the plural', () => {
    const one = renderDunningEmail({
      ...common,
      day: 1,
      graceEndsAt: grace,
      amountCents: 1_800_000,
    });
    const three = renderDunningEmail({
      ...common,
      day: 3,
      graceEndsAt: grace,
      amountCents: 1_800_000,
    });

    expect(one.text).toContain('Pasaron 1 día desde el primer intento');
    expect(three.text).toContain('Pasaron 3 días desde el primer intento');
    expect(three.text).toContain('$ 18.000,00');
  });

  it('announces read-only and recovery, and says a simulated environment is simulated', () => {
    const readOnly = renderReadOnlyEmail({ ...common, simulated: true });
    const recovered = renderRecoveredEmail(common);

    expect(readOnly.subject).toBe('Su cuenta pasó a solo lectura');
    expect(readOnly.text).toContain('se pueden exportar en cualquier momento');
    expect(readOnly.text).toContain('el pago es simulado');
    expect(recovered.subject).toBe('Recibimos su pago');
    expect(recovered.text).toContain('no se envían');
    expect(recovered.text).not.toContain('simulado');
  });

  it('never carries a patient, a record or a card in any of them', () => {
    const all = [
      renderPastDueEmail({
        ...common,
        cause: 'payment_failed',
        graceEndsAt: grace,
        amountCents: 1,
      }),
      renderDunningEmail({ ...common, day: 5, graceEndsAt: grace, amountCents: 1 }),
      renderReadOnlyEmail(common),
      renderRecoveredEmail(common),
    ];

    for (const email of all) {
      expect(`${email.subject}\n${email.text}`).not.toMatch(
        /tarjeta|historia clínica|diagnóstico|DNI/i,
      );
    }
  });
});
