/** Hours before the start at which a reminder may be sent: 1 hour to 14 days. */
const MIN_HOURS = 1;
const MAX_HOURS = 24 * 14;

export interface LeadTimeCheck {
  /** The whole hours, when every entry is right; null while any entry has an error. */
  hours: number[] | null;
  /** One entry per typed value: the translation key of its error, or null. */
  errors: (string | null)[];
}

/**
 * Checks the lead times an administrator typed, one text per field. The server repeats the rules
 * (`NotificationSettings`); this gives the message next to the field that is wrong.
 */
export function validateLeadTimes(typed: readonly string[]): LeadTimeCheck {
  const seen = new Set<number>();
  const hours: number[] = [];
  const errors = typed.map((raw): string | null => {
    const text = raw.trim();
    if (text === '') return 'messaging:reminders.error.required';
    if (!/^\d+$/.test(text)) return 'messaging:reminders.error.range';
    const value = Number(text);
    if (value < MIN_HOURS || value > MAX_HOURS) return 'messaging:reminders.error.range';
    if (seen.has(value)) return 'messaging:reminders.error.repeated';
    seen.add(value);
    hours.push(value);
    return null;
  });
  return { hours: errors.every((error) => error === null) ? hours : null, errors };
}
