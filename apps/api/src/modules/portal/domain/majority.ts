/**
 * The day a representative link is reviewed: the day the dependent reaches the age of majority of
 * the country (patient-portal, "Legal representatives and dependents"). For somebody who is already
 * an adult there is nothing to wait for, so there is no date: the organization verified the
 * representation when it linked them.
 */
export function majorityReviewDate(input: {
  /** `YYYY-MM-DD`. */
  birthDate: string;
  majorityAge: number;
  today: Date;
}): string | null {
  const [year, month, day] = input.birthDate.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error('birth date is not an ISO date');
  }
  // `Date.UTC` rolls 29 February of a non-leap year into 1 March, which is the day a person born
  // on the 29th is treated as having their birthday.
  const review = new Date(Date.UTC(year + input.majorityAge, month - 1, day));
  const todayStart = Date.UTC(
    input.today.getUTCFullYear(),
    input.today.getUTCMonth(),
    input.today.getUTCDate(),
  );
  if (review.getTime() <= todayStart) return null;
  return review.toISOString().slice(0, 10);
}
