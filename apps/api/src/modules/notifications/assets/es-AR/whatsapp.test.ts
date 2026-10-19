import { describe, expect, it } from 'vitest';

import { whatsappBody } from './whatsapp.js';

const vars = {
  name: 'María',
  organization: 'Centro Médico Aillu',
  date: 'lunes 12 de mayo',
  time: '10:00',
  place: 'Sede Centro',
};

describe('the WhatsApp text of a waitlist offer', () => {
  it('carries the address that accepts the offer and the time it closes', () => {
    const body = whatsappBody('waitlist_offer', {
      ...vars,
      offerUrl: 'https://aillu.example.test/public/t/OFFER',
      offerExpires: '09:30',
    });

    expect(body).toContain('https://aillu.example.test/public/t/OFFER');
    expect(body).toContain('09:30');
    expect(body).toContain('BAJA');
  });
});

describe('the WhatsApp reminder text of a video consultation', () => {
  it('shows the mode and the join address when the message carries one', () => {
    const body = whatsappBody('appointment_reminder', {
      ...vars,
      mode: 'Videollamada',
      joinUrl: 'https://aillu.example.test/public/v/JOIN',
    });

    expect(body).toContain('Modalidad: Videollamada');
    expect(body).toContain('https://aillu.example.test/public/v/JOIN');
  });

  it('says the link follows when the mode is video and there is no address yet', () => {
    const body = whatsappBody('appointment_reminder', { ...vars, mode: 'Videollamada' });

    expect(body).toContain('Modalidad: Videollamada');
    expect(body).toContain('enlace');
    expect(body).toContain('por separado');
    expect(body).not.toContain('http');
  });

  it('leaves an in-person appointment as it was', () => {
    const body = whatsappBody('appointment_reminder', vars);

    expect(body).not.toContain('Modalidad');
    expect(body).not.toContain('enlace');
  });

  it('puts the address in the confirmation too', () => {
    const body = whatsappBody('appointment_confirmation', {
      ...vars,
      mode: 'Videollamada',
      joinUrl: 'https://aillu.example.test/public/v/JOIN',
    });

    expect(body).toContain('https://aillu.example.test/public/v/JOIN');
  });
});

describe('the WhatsApp text of the follow-up with the video link', () => {
  const joinUrl = 'https://aillu.example.test/public/v/JOIN';

  it('gives the address, says it is the video visit and lets the patient opt out', () => {
    const body = whatsappBody('video_link', { ...vars, mode: 'Videollamada', joinUrl });

    expect(body).toContain('enlace de su videoconsulta');
    expect(body).toContain('Modalidad: Videollamada');
    expect(body).toContain(joinUrl);
    expect(body).toContain('BAJA');
  });

  it('does not ask to confirm or cancel the appointment again', () => {
    const body = whatsappBody('video_link', { ...vars, mode: 'Videollamada', joinUrl });

    expect(body).not.toContain('Responda 1');
    expect(body).not.toContain('Responda 2');
  });
});

describe('the acknowledgment of a BAJA (owner decision B7)', () => {
  it('names the organization and says no more messages will come on any channel', () => {
    const body = whatsappBody('optout_ack', vars);

    expect(body).toContain(
      'Centro Médico Aillu no le enviará más mensajes por WhatsApp ni por email',
    );
    expect(body).toContain('avise en la recepción');
  });
});
