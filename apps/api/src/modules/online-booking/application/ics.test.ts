import { describe, expect, it } from 'vitest';

import { renderIcs } from './ics.js';

const base = {
  uid: '0190a000-0000-7000-8000-000000000001',
  organizationName: 'Centro Médico Aillu',
  professionalName: 'Dra. Ana Pérez',
  locationName: 'Sede Centro',
  startsAt: new Date('2031-05-12T13:00:00.000Z'),
  endsAt: new Date('2031-05-12T13:30:00.000Z'),
  confirmed: true,
  now: new Date('2031-05-05T12:00:00.000Z'),
};

describe('renderIcs', () => {
  it('writes a calendar file with the appointment in UTC and CRLF line ends', () => {
    const file = renderIcs(base);

    expect(file).toBe(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Consulvia//Turnos//ES',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        'UID:0190a000-0000-7000-8000-000000000001@consulvia',
        'DTSTAMP:20310505T120000Z',
        'DTSTART:20310512T130000Z',
        'DTEND:20310512T133000Z',
        'SUMMARY:Turno en Centro Médico Aillu',
        'LOCATION:Sede Centro',
        'DESCRIPTION:Profesional: Dra. Ana Pérez',
        'STATUS:CONFIRMED',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
    );
  });

  it('marks a booking that still waits for approval as tentative', () => {
    expect(renderIcs({ ...base, confirmed: false })).toContain('STATUS:TENTATIVE');
  });

  it('escapes the characters the format reserves', () => {
    const file = renderIcs({ ...base, organizationName: 'Salud; Hogar, SA\\Sur' });

    expect(file).toContain('SUMMARY:Turno en Salud\\; Hogar\\, SA\\\\Sur');
  });

  it('cannot be made to inject a line: new lines in a name are dropped', () => {
    const file = renderIcs({
      ...base,
      professionalName: 'Dr. X\r\nATTENDEE:mailto:evil@example.test',
    });

    expect(file.split('\r\n').filter((line) => line.startsWith('ATTENDEE'))).toEqual([]);
  });

  it('folds lines longer than 75 octets, continuing with a space', () => {
    const file = renderIcs({ ...base, organizationName: 'A'.repeat(200) });

    for (const line of file.split('\r\n')) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    }
    expect(file).toMatch(/\r\n AAAA/);
  });

  it('carries nothing clinical: no type of visit, no patient, no reason', () => {
    const file = renderIcs(base);

    expect(file).not.toMatch(/PATIENT|ATTENDEE|ORGANIZER|motivo|diagn/i);
  });
});
