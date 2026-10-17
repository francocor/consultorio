import { describe, expect, it } from 'vitest';

import { whatsappBody } from './whatsapp.js';

const vars = {
  name: 'María',
  organization: 'Centro Médico Aillu',
  date: 'lunes 12 de mayo',
  time: '10:00',
  place: 'Sede Centro',
};

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
