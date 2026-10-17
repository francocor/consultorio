import { describe, expect, it } from 'vitest';

import type { AppointmentFacts, Wording } from '../domain/content.js';

import { renderMessage, type RenderInput } from './render.js';

const facts: AppointmentFacts = {
  organizationName: 'Centro Médico Aillu',
  patientGivenNames: 'María Laura',
  // 2031-05-12 13:00 UTC is 10:00 in Buenos Aires.
  startsAt: new Date('2031-05-12T13:00:00.000Z'),
  timeZone: 'America/Argentina/Buenos_Aires',
  locationName: 'Sede Centro',
  professionalName: 'Dra. Paula Ríos',
  appointmentTypeName: 'Consulta',
};
const showAll: Wording = { hideProfessional: false, hideAppointmentType: false };
const links = {
  confirmUrl: 'https://aillu.example.test/public/t/CONFIRM',
  cancelUrl: 'https://aillu.example.test/public/t/CANCEL',
  optOutUrl: 'https://aillu.example.test/public/t/OPTOUT',
};

const email = (overrides: Partial<RenderInput> = {}) => {
  const rendered = renderMessage({
    kind: 'reminder',
    channel: 'email',
    facts,
    wording: showAll,
    links,
    ...overrides,
  });
  if (rendered.channel !== 'email') throw new Error('expected an email');
  return rendered;
};

describe('renderMessage for email', () => {
  it('writes the reminder in es-AR with first name, date, time, place, professional and type', () => {
    const rendered = email();

    expect(rendered.subject).toBe('Recordatorio de su turno en Centro Médico Aillu');
    expect(rendered.text).toBe(
      [
        'Hola María:',
        '',
        'Le recordamos su turno en Centro Médico Aillu.',
        '',
        'Fecha: lunes 12 de mayo',
        'Hora: 10:00',
        'Lugar: Sede Centro',
        'Profesional: Dra. Paula Ríos',
        'Tipo de turno: Consulta',
        '',
        'Para confirmar su asistencia, abra este enlace:',
        'https://aillu.example.test/public/t/CONFIRM',
        '',
        'Si no puede asistir, puede cancelar el turno desde este enlace:',
        'https://aillu.example.test/public/t/CANCEL',
        '',
        'Para dejar de recibir recordatorios por email, use este enlace:',
        'https://aillu.example.test/public/t/OPTOUT',
      ].join('\n'),
    );
  });

  it('puts the same facts and the three links in the HTML part', () => {
    const { html } = email();

    expect(html).toContain('lunes 12 de mayo');
    expect(html).toContain('10:00');
    expect(html).toContain('Dra. Paula Ríos');
    expect(html).toContain('href="https://aillu.example.test/public/t/CONFIRM"');
    expect(html).toContain('href="https://aillu.example.test/public/t/CANCEL"');
    expect(html).toContain('href="https://aillu.example.test/public/t/OPTOUT"');
    expect(html).toContain('lang="es-AR"');
  });

  it('uses neutral wording when the organization hides the professional and the type', () => {
    const { text, html, subject } = email({
      wording: { hideProfessional: true, hideAppointmentType: true },
    });

    for (const part of [text, html, subject]) {
      expect(part).not.toContain('Paula');
      expect(part).not.toContain('Consulta');
      expect(part).not.toContain('Profesional:');
    }
    expect(text).toContain('Fecha: lunes 12 de mayo');
    expect(text).toContain('Hora: 10:00');
    expect(text).toContain('Lugar: Sede Centro');
  });

  it('hides each of the two independently', () => {
    const noProfessional = email({
      wording: { hideProfessional: true, hideAppointmentType: false },
    });
    const noType = email({ wording: { hideProfessional: false, hideAppointmentType: true } });

    expect(noProfessional.text).not.toContain('Paula');
    expect(noProfessional.text).toContain('Tipo de turno: Consulta');
    expect(noType.text).toContain('Profesional: Dra. Paula Ríos');
    expect(noType.text).not.toContain('Tipo de turno');
  });

  it('renders the organization of each tenant and nothing of another one', () => {
    const north = email({ facts: { ...facts, organizationName: 'Clínica Norte' } });
    const south = email({ facts: { ...facts, organizationName: 'Consultorio Sur' } });

    expect(north.subject).toBe('Recordatorio de su turno en Clínica Norte');
    expect(north.text).toContain('en Clínica Norte.');
    expect(north.text).not.toContain('Aillu');
    expect(south.subject).toBe('Recordatorio de su turno en Consultorio Sur');
    expect(south.text).not.toContain('Clínica Norte');
  });

  it('reads the date and the time in the time zone of the location', () => {
    const instant = new Date('2031-05-12T22:30:00.000Z');
    const buenosAires = email({ facts: { ...facts, startsAt: instant } });
    const madrid = email({ facts: { ...facts, startsAt: instant, timeZone: 'Europe/Madrid' } });

    expect(buenosAires.text).toContain('Fecha: lunes 12 de mayo');
    expect(buenosAires.text).toContain('Hora: 19:30');
    expect(madrid.text).toContain('Fecha: martes 13 de mayo');
    expect(madrid.text).toContain('Hora: 00:30');
  });

  it('greets with the first name only, never the surname', () => {
    const { text } = email({ facts: { ...facts, patientGivenNames: '  Juan   Carlos ' } });

    expect(text.startsWith('Hola Juan:')).toBe(true);
    expect(text).not.toContain('Carlos');
  });

  it('escapes what an organization or a person typed before it reaches the HTML', () => {
    const { html } = email({
      facts: {
        ...facts,
        organizationName: 'Centro <script>alert(1)</script>',
        locationName: 'A & B',
      },
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain('Centro &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('A &amp; B');
  });

  it('refuses a link that is not a web link', () => {
    expect(() =>
      renderMessage({
        kind: 'reminder',
        channel: 'email',
        facts,
        wording: showAll,
        links: { ...links, confirmUrl: 'javascript:alert(1)' },
      }),
    ).toThrow('http(s)');
  });

  it('writes the booking confirmation without asking to confirm again', () => {
    const rendered = email({ kind: 'confirmation' });

    expect(rendered.subject).toBe('Su turno en Centro Médico Aillu está confirmado');
    expect(rendered.text).toContain('Registramos su turno en Centro Médico Aillu.');
    expect(rendered.text).not.toContain('CONFIRM');
    expect(rendered.text).toContain('https://aillu.example.test/public/t/CANCEL');
  });

  it('writes the waitlist offer around the link that accepts it', () => {
    const rendered = email({
      kind: 'waitlist_offer',
      links: { ...links, offerUrl: 'https://aillu.example.test/public/t/OFFER' },
    });

    expect(rendered.subject).toBe('Hay un turno disponible en Centro Médico Aillu');
    expect(rendered.text).toContain('https://aillu.example.test/public/t/OFFER');
    expect(rendered.text).toContain('Hora: 10:00');
  });

  it('needs the offer link to write an offer', () => {
    expect(() => email({ kind: 'waitlist_offer' })).toThrow('offer');
  });
});

describe('renderMessage for WhatsApp', () => {
  const whatsapp = (overrides: Partial<RenderInput> = {}) => {
    const rendered = renderMessage({
      kind: 'reminder',
      channel: 'whatsapp',
      facts,
      wording: showAll,
      ...overrides,
    });
    if (rendered.channel !== 'whatsapp') throw new Error('expected WhatsApp');
    return rendered;
  };

  it('names an approved template and fills its variables', () => {
    expect(whatsapp()).toEqual({
      channel: 'whatsapp',
      templateKey: 'appointment_reminder',
      vars: {
        name: 'María',
        organization: 'Centro Médico Aillu',
        date: 'lunes 12 de mayo',
        time: '10:00',
        place: 'Sede Centro',
        professional: 'Dra. Paula Ríos',
        type: 'Consulta',
      },
    });
  });

  it('uses one template per kind', () => {
    expect(whatsapp({ kind: 'confirmation' }).templateKey).toBe('appointment_confirmation');
    expect(whatsapp({ kind: 'waitlist_offer' }).templateKey).toBe('waitlist_offer');
  });

  it('leaves the professional and the type out of the variables under neutral wording', () => {
    const { vars } = whatsapp({ wording: { hideProfessional: true, hideAppointmentType: true } });

    expect(vars).toEqual({
      name: 'María',
      organization: 'Centro Médico Aillu',
      date: 'lunes 12 de mayo',
      time: '10:00',
      place: 'Sede Centro',
    });
  });
});

describe('renderMessage for a waitlist offer', () => {
  const offerUrl = 'https://aillu.example.test/public/t/OFFER';
  const offerFacts = {
    ...facts,
    appointmentTypeName: null,
    offerExpiresAt: new Date('2031-05-12T12:30:00.000Z'),
  };

  it('says until what time the offer is open, in the zone of the location', () => {
    const rendered = email({ kind: 'waitlist_offer', facts: offerFacts, links: { offerUrl } });

    // 12:30 UTC is 09:30 in Buenos Aires.
    expect(rendered.text).toContain(
      'Para aceptarlo o rechazarlo, abra este enlace antes de las 09:30:',
    );
    expect(rendered.text).toContain(offerUrl);
    expect(rendered.html).toContain(`href="${offerUrl}"`);
  });

  it('keeps the plain sentence when the expiry is not known', () => {
    const rendered = email({ kind: 'waitlist_offer', links: { offerUrl } });

    expect(rendered.text).toContain('antes de que venza la oferta');
  });

  it('gives the WhatsApp template the address that accepts the offer, and the time it closes', () => {
    const rendered = renderMessage({
      kind: 'waitlist_offer',
      channel: 'whatsapp',
      facts: offerFacts,
      wording: showAll,
      links: { offerUrl },
    });

    expect(rendered.channel === 'whatsapp' && rendered.vars).toMatchObject({
      offerUrl,
      offerExpires: '09:30',
    });
  });

  it('refuses an offer address that is not a web link on WhatsApp either', () => {
    expect(() =>
      renderMessage({
        kind: 'waitlist_offer',
        channel: 'whatsapp',
        facts,
        wording: showAll,
        links: { offerUrl: 'javascript:alert(1)' },
      }),
    ).toThrow('http(s)');
  });

  it('does not put an offer address in a reminder', () => {
    const rendered = renderMessage({
      kind: 'reminder',
      channel: 'whatsapp',
      facts,
      wording: showAll,
      links: { offerUrl },
    });

    expect(rendered.channel === 'whatsapp' && rendered.vars).not.toHaveProperty('offerUrl');
  });
});

describe('renderMessage for a video consultation', () => {
  const join = 'https://aillu.example.test/public/v/JOIN';

  it('writes the join address into the email, as text and as a link, and names the mode', () => {
    const rendered = email({ video: { kind: 'link', url: join } });

    expect(rendered.text).toContain('Modalidad: Videollamada');
    expect(rendered.text).toContain(join);
    expect(rendered.html).toContain(`href="${join}"`);
    expect(rendered.html).toContain('Unirse a la videollamada');
    // The other links are still there.
    expect(rendered.text).toContain('https://aillu.example.test/public/t/CONFIRM');
  });

  it('says the link follows when the room does not exist yet, instead of inventing one', () => {
    const rendered = email({ video: { kind: 'pending' } });

    expect(rendered.text).toContain('Modalidad: Videollamada');
    expect(rendered.text).toContain('le enviaremos el enlace por separado');
    expect(rendered.text).not.toContain('/public/v/');
    expect(rendered.html).not.toContain('Unirse a la videollamada');
  });

  it('writes nothing about video for an in-person appointment', () => {
    const rendered = email();

    expect(rendered.text).not.toContain('Modalidad');
    expect(rendered.text).not.toContain('videollamada');
    expect(rendered.html).not.toContain('videollamada');
  });

  it('carries the link in a confirmation too', () => {
    const rendered = email({ kind: 'confirmation', video: { kind: 'link', url: join } });

    expect(rendered.text).toContain(join);
  });

  it('refuses a join address that is not a web link', () => {
    expect(() => email({ video: { kind: 'link', url: 'javascript:alert(1)' } })).toThrow('http(s)');
  });

  it('passes the join address to the WhatsApp template as a variable, and the mode', () => {
    const rendered = renderMessage({
      kind: 'reminder',
      channel: 'whatsapp',
      facts,
      wording: showAll,
      video: { kind: 'link', url: join },
    });

    expect(rendered.channel === 'whatsapp' && rendered.vars).toMatchObject({
      mode: 'Videollamada',
      joinUrl: join,
    });
  });

  it('marks a WhatsApp message whose link follows with the mode and no address', () => {
    const rendered = renderMessage({
      kind: 'reminder',
      channel: 'whatsapp',
      facts,
      wording: showAll,
      video: { kind: 'pending' },
    });

    expect(rendered.channel === 'whatsapp' && rendered.vars).toMatchObject({
      mode: 'Videollamada',
    });
    expect(rendered.channel === 'whatsapp' && rendered.vars).not.toHaveProperty('joinUrl');
  });
});

describe('the render input has no clinical fields', () => {
  it('rejects, at compile time, a field that is not administrative', () => {
    const withDiagnosis = renderMessage({
      kind: 'reminder',
      channel: 'email',
      // @ts-expect-error a diagnosis is not part of what a message may be written from
      facts: { ...facts, diagnosis: 'hipertensión' },
      wording: showAll,
      links,
    });
    const withNote = renderMessage({
      kind: 'reminder',
      channel: 'email',
      facts,
      wording: showAll,
      links,
      // @ts-expect-error clinical notes are not an input of a message either
      clinicalNote: 'nota',
    });

    expect(withDiagnosis.channel).toBe('email');
    expect(JSON.stringify(withNote)).not.toContain('nota');
  });

  it('never prints a field it was not designed to print, even when one slips in at run time', () => {
    const smuggled = { ...facts, diagnosis: 'hipertensión' } as unknown as AppointmentFacts;
    const { text, html } = email({ facts: smuggled });

    expect(text).not.toContain('hipertensión');
    expect(html).not.toContain('hipertensión');
  });
});

describe('renderMessage for the follow-up with the video link', () => {
  const join = 'https://aillu.example.test/public/v/JOIN';
  const video = { kind: 'link', url: join } as const;

  it('writes an email that is about the link: subject, address and the opt-out, nothing to confirm', () => {
    const rendered = email({
      kind: 'video_link',
      video,
      links: { optOutUrl: links.optOutUrl },
    });

    expect(rendered.subject).toBe('El enlace de su videoconsulta en Centro Médico Aillu');
    expect(rendered.text).toContain('Este es el enlace para conectarse a su videoconsulta');
    expect(rendered.text).toContain('Modalidad: Videollamada');
    expect(rendered.text).toContain(join);
    expect(rendered.text).toContain(links.optOutUrl);
    expect(rendered.text).not.toContain('confirmar');
    expect(rendered.html).toContain(`href="${join}"`);
  });

  it('needs the join address to write it', () => {
    expect(() => email({ kind: 'video_link' })).toThrow('video link');
    expect(() => email({ kind: 'video_link', video: { kind: 'pending' } })).toThrow('video link');
  });

  it('uses its own WhatsApp template and hands it the mode and the address', () => {
    const rendered = renderMessage({
      kind: 'video_link',
      channel: 'whatsapp',
      facts,
      wording: showAll,
      video,
    });

    expect(rendered.channel === 'whatsapp' && rendered.templateKey).toBe('video_link');
    expect(rendered.channel === 'whatsapp' && rendered.vars).toMatchObject({
      mode: 'Videollamada',
      joinUrl: join,
    });
  });

  it('refuses a join address that is not a web link', () => {
    expect(() =>
      renderMessage({
        kind: 'video_link',
        channel: 'whatsapp',
        facts,
        wording: showAll,
        video: { kind: 'link', url: 'javascript:alert(1)' },
      }),
    ).toThrow('http(s)');
  });
});
