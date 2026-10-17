import { describe, expect, it } from 'vitest';

import { renderOfferEmail } from './offer-email.js';

const base = {
  organizationName: 'Centro Médico Aillu',
  firstName: 'Lucía',
  professionalName: 'Dra. Pérez',
  locationName: 'Sede Centro',
  startsAt: new Date('2031-05-12T13:00:00Z'),
  timeZone: 'America/Argentina/Buenos_Aires',
  expiresAt: new Date('2031-05-12T00:30:00Z'),
  link: 'https://aillu.consultorio.test/public/t/abc',
};

describe('the email of an offer', () => {
  it('says when, where and with whom, in the time of the place, and carries the link', () => {
    const email = renderOfferEmail(base);

    expect(email.subject).toBe('Hay un turno disponible en Centro Médico Aillu');
    expect(email.text).toContain('lunes, 12 de mayo de 2031, 10:00');
    expect(email.text).toContain('Sede Centro');
    expect(email.text).toContain('Dra. Pérez');
    expect(email.text).toContain('https://aillu.consultorio.test/public/t/abc');
    expect(email.html).toContain('href="https://aillu.consultorio.test/public/t/abc"');
  });

  it('greets with the first name only and states when the offer ends', () => {
    const email = renderOfferEmail({ ...base, firstName: 'Lucía María' });

    expect(email.text.startsWith('Hola Lucía,')).toBe(true);
    expect(email.text).not.toContain('María');
    // 00:30 UTC is 21:30 the night before in Buenos Aires.
    expect(email.text).toContain('21:30');
  });

  it('leaves the professional out when the organization hides it', () => {
    const email = renderOfferEmail({ ...base, professionalName: null });

    expect(email.text).not.toContain('Dra. Pérez');
    expect(email.text).not.toContain('Con:');
    expect(email.html).not.toContain('Con:');
  });

  it('escapes what it puts in the html', () => {
    const email = renderOfferEmail({
      ...base,
      locationName: 'Sede <b>Centro</b> & Norte',
      link: 'https://aillu.consultorio.test/public/t/a"b',
    });

    expect(email.html).not.toContain('<b>');
    expect(email.html).toContain('Sede &lt;b&gt;Centro&lt;/b&gt; &amp; Norte');
    expect(email.html).toContain('href="https://aillu.consultorio.test/public/t/a&quot;b"');
  });

  it('says nothing clinical: no type of visit, no reason', () => {
    const email = renderOfferEmail(base);

    expect(email.text.toLowerCase()).not.toMatch(/motivo|diagn|consulta por|tratamiento/);
  });
});
