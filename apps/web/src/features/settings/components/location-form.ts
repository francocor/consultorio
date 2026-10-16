/** Time zones offered for a location: the Argentine provinces' IANA zones plus UTC. */
export const TIME_ZONES = [
  'America/Argentina/Buenos_Aires',
  'America/Argentina/Cordoba',
  'America/Argentina/Salta',
  'America/Argentina/Jujuy',
  'America/Argentina/Tucuman',
  'America/Argentina/Catamarca',
  'America/Argentina/La_Rioja',
  'America/Argentina/San_Juan',
  'America/Argentina/Mendoza',
  'America/Argentina/San_Luis',
  'America/Argentina/Rio_Gallegos',
  'America/Argentina/Ushuaia',
  'UTC',
] as const;

/** `Buenos Aires (GMT-03:00)`: the city of a zone and its offset, which is what people recognize. */
export function describeTimeZone(zone: string, at: Date = new Date()): string {
  const city = (zone.split('/').pop() ?? zone).replaceAll('_', ' ');
  const offset =
    new Intl.DateTimeFormat('es-AR', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value ?? '';
  return zone === 'UTC' ? 'UTC' : `${city} (${offset})`;
}
