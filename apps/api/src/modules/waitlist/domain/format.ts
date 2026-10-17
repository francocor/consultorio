/**
 * How the waitlist writes a date and a time for a person: es-AR, in the zone of the place where the
 * visit is, never the zone of the server or the device.
 */

/** "lunes, 12 de mayo de 2031". */
export function dateText(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

/** "10:00", 24 hours. */
export function timeText(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}
