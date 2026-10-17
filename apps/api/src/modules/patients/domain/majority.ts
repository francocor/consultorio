function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * The day a person born on `birthDate` (YYYY-MM-DD) reaches the age of majority of their country.
 * Born on 29 February, in a year without one the day is 1 March: the person is never treated as an
 * adult a day early.
 */
export function majorityDate(birthDate: string, majorityAge: number): string {
  const [year = 0, month = 1, day = 1] = birthDate.split('-').map(Number);
  const target = year + majorityAge;
  const leapDayWithoutLeapYear = month === 2 && day === 29 && !isLeapYear(target);
  const finalMonth = leapDayWithoutLeapYear ? 3 : month;
  const finalDay = leapDayWithoutLeapYear ? 1 : day;
  return `${String(target).padStart(4, '0')}-${String(finalMonth).padStart(2, '0')}-${String(finalDay).padStart(2, '0')}`;
}

/** True while `today` (YYYY-MM-DD) is before the day the person reaches majority. */
export function isMinor(birthDate: string, today: string, majorityAge: number): boolean {
  return today < majorityDate(birthDate, majorityAge);
}
