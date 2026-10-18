import { describe, expect, it } from 'vitest';

import { renderBookingConfirmationEmail, whenText } from './confirmation-email.js';

const base = {
  organizationName: 'Centro Médico Aillu',
  professionalName: 'Dra. Ana Pérez',
  locationName: 'Sede Centro',
  startsAt: new Date('2031-05-12T13:00:00.000Z'),
  timeZone: 'America/Argentina/Buenos_Aires',
  pendingApproval: false,
  manageLink: 'https://aillu.example.test/book/manage/abc',
};

describe('whenText', () => {
  it('reads the instant in the zone of the location, in Spanish', () => {
    expect(whenText(base.startsAt, base.timeZone)).toBe('lunes, 12 de mayo de 2031, 10:00');
  });
});

describe('renderBookingConfirmationEmail', () => {
  it('confirms a booking with when, where, who and the link to change it', () => {
    const email = renderBookingConfirmationEmail(base);

    expect(email.subject).toBe('Su turno en Centro Médico Aillu está confirmado');
    expect(email.text).toContain('Su turno está confirmado.');
    expect(email.text).toContain('Cuándo: lunes, 12 de mayo de 2031, 10:00');
    expect(email.text).toContain('Dónde: Sede Centro');
    expect(email.text).toContain('Con: Dra. Ana Pérez');
    expect(email.text).toContain('https://aillu.example.test/book/manage/abc');
    expect(email.html).toContain('href="https://aillu.example.test/book/manage/abc"');
  });

  it('says a booking that waits for approval is not confirmed yet', () => {
    const email = renderBookingConfirmationEmail({ ...base, pendingApproval: true });

    expect(email.subject).toContain('Recibimos su pedido');
    expect(email.text).toContain('lo va a confirmar');
    expect(email.text).not.toContain('está confirmado');
  });

  it('leaves the link out when there is nothing left to change', () => {
    const email = renderBookingConfirmationEmail({ ...base, manageLink: null });

    expect(email.text).not.toContain('enlace');
    expect(email.html).not.toContain('href=');
  });

  it('escapes what the organization typed into its names', () => {
    const email = renderBookingConfirmationEmail({
      ...base,
      professionalName: '<script>alert(1)</script>',
    });

    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
  });

  it('offers the link to accept reminders by WhatsApp when the visitor asked for them', () => {
    const email = renderBookingConfirmationEmail({
      ...base,
      whatsappOptInLink: 'https://aillu.example.test/public/t/xyz',
    });

    expect(email.text).toContain('WhatsApp');
    expect(email.text).toContain('https://aillu.example.test/public/t/xyz');
    expect(email.html).toContain('href="https://aillu.example.test/public/t/xyz"');
    expect(renderBookingConfirmationEmail(base).text).not.toContain('WhatsApp');
  });

  it('carries no patient, no type of visit and no reason', () => {
    const email = renderBookingConfirmationEmail(base);

    expect(`${email.subject}${email.text}${email.html}`).not.toMatch(
      /paciente|motivo|consulta de/i,
    );
  });
});
