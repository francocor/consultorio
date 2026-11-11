/**
 * An instant as a patient reads it: the date and the time in the time zone of the place where the
 * appointment is (the location's zone is authoritative, not the server's or the browser's).
 */
export function describeInstant(instant: Date, timeZone: string): { date: string; time: string } {
  const date = new Intl.DateTimeFormat('es-AR', {
    timeZone,
    day: 'numeric',
    month: 'long',
  }).format(instant);
  const time = new Intl.DateTimeFormat('es-AR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
  return { date, time };
}
