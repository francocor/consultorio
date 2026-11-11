export interface IcsInput {
  /** The appointment id: the same file replaces itself in a calendar if it is opened again. */
  uid: string;
  organizationName: string;
  professionalName: string;
  locationName: string;
  startsAt: Date;
  endsAt: Date;
  /** False while the booking waits for approval. */
  confirmed: boolean;
  now: Date;
}

/** `20310512T130000Z`. */
function utc(instant: Date): string {
  return instant
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/** Text values: the characters the format reserves are escaped and line breaks are dropped. */
function text(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,');
}

/** Lines are at most 75 octets: the rest continues on the next line, which starts with a space. */
function fold(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (const character of line) {
    const limit = parts.length === 0 ? 75 : 74;
    if (Buffer.byteLength(current + character) > limit) {
      parts.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  parts.push(current);
  return parts.map((part, index) => (index === 0 ? part : ` ${part}`));
}

/**
 * The calendar file of a booking (online-booking, "Booking completion"): when, where and with
 * whom. It names no patient, no type of visit and no reason, so what a calendar app syncs to other
 * devices carries nothing clinical.
 */
export function renderIcs(input: IcsInput): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Consulvia//Turnos//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${input.uid}@consulvia`,
    `DTSTAMP:${utc(input.now)}`,
    `DTSTART:${utc(input.startsAt)}`,
    `DTEND:${utc(input.endsAt)}`,
    `SUMMARY:Turno en ${text(input.organizationName)}`,
    `LOCATION:${text(input.locationName)}`,
    `DESCRIPTION:Profesional: ${text(input.professionalName)}`,
    `STATUS:${input.confirmed ? 'CONFIRMED' : 'TENTATIVE'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.flatMap(fold).join('\r\n')}\r\n`;
}
