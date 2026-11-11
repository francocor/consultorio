/** `YYYY-MM-DD` of an instant, in UTC. A birth date has no time zone; the day is close enough. */
function dayOf(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** The date a person born on `birthDate` reaches `years` of age (29 February becomes 1 March). */
function anniversary(birthDate: string, years: number): string {
  const [year = 0, month = 1, day = 1] = birthDate.split('-').map(Number);
  const target = new Date(Date.UTC(year + years, month - 1, day));
  // A leap-day birthday in a year without one rolls over to 1 March by itself.
  return target.toISOString().slice(0, 10);
}

/** True while the person has not yet reached the age of majority of the country. */
export function isMinor(birthDate: string, majorityAge: number, today: Date): boolean {
  return anniversary(birthDate, majorityAge) > dayOf(today);
}

export function isFutureDate(date: string, today: Date): boolean {
  return date > dayOf(today);
}
