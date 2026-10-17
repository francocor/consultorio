import type { OnlineBookingSettings } from '@consultorio/contracts';

/** The rules as the form holds them: text for every number, so a half-typed value is representable. */
export interface RulesDraft {
  minLeadHours: string;
  horizonDays: string;
  /** Empty means no cap. */
  dailyCap: string;
  rescheduleDeadlineHours: string;
  requireApproval: boolean;
}

export type RulesField = Exclude<keyof RulesDraft, 'requireApproval'>;

export function draftOf(settings: OnlineBookingSettings): RulesDraft {
  return {
    minLeadHours: String(settings.minLeadHours),
    horizonDays: String(settings.horizonDays),
    dailyCap: settings.dailyCap === null ? '' : String(settings.dailyCap),
    rescheduleDeadlineHours: String(settings.rescheduleDeadlineHours),
    requireApproval: settings.requireApproval,
  };
}

export interface RulesCheck {
  /** Every rule, when all of them are right; null while any of them is wrong. */
  values: OnlineBookingSettings | null;
  /** The translation key of the error of each wrong field. */
  errors: Partial<Record<RulesField, string>>;
}

/** The same ranges as `OnlineBookingSettings`; the server repeats them. */
const LIMITS = {
  minLeadHours: { min: 0, max: 24 * 14, error: 'bookingAdmin:rules.error.lead' },
  horizonDays: { min: 1, max: 365, error: 'bookingAdmin:rules.error.horizon' },
  dailyCap: { min: 1, max: 500, error: 'bookingAdmin:rules.error.cap' },
  rescheduleDeadlineHours: { min: 0, max: 24 * 14, error: 'bookingAdmin:rules.error.deadline' },
} as const;

function whole(text: string, field: RulesField): number | string {
  const { min, max, error } = LIMITS[field];
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return error;
  const value = Number(trimmed);
  return value < min || value > max ? error : value;
}

/** Checks what was typed and reads it back as numbers. */
export function validateRules(draft: RulesDraft): RulesCheck {
  const errors: Partial<Record<RulesField, string>> = {};
  const read = (field: RulesField): number => {
    const result = whole(draft[field], field);
    if (typeof result === 'string') {
      errors[field] = result;
      return 0;
    }
    return result;
  };
  const minLeadHours = read('minLeadHours');
  const horizonDays = read('horizonDays');
  const rescheduleDeadlineHours = read('rescheduleDeadlineHours');
  const dailyCap = draft.dailyCap.trim() === '' ? null : read('dailyCap');
  if (Object.keys(errors).length > 0) return { values: null, errors };
  return {
    values: {
      minLeadHours,
      horizonDays,
      dailyCap,
      rescheduleDeadlineHours,
      requireApproval: draft.requireApproval,
    },
    errors,
  };
}

/** Only what changed: saving a rule does not rewrite (and audit) the others. Null: nothing changed. */
export function patchOf(
  current: OnlineBookingSettings,
  next: OnlineBookingSettings,
): Partial<OnlineBookingSettings> | null {
  const patch: Partial<OnlineBookingSettings> = {};
  if (next.minLeadHours !== current.minLeadHours) patch.minLeadHours = next.minLeadHours;
  if (next.horizonDays !== current.horizonDays) patch.horizonDays = next.horizonDays;
  if (next.dailyCap !== current.dailyCap) patch.dailyCap = next.dailyCap;
  if (next.rescheduleDeadlineHours !== current.rescheduleDeadlineHours) {
    patch.rescheduleDeadlineHours = next.rescheduleDeadlineHours;
  }
  if (next.requireApproval !== current.requireApproval) {
    patch.requireApproval = next.requireApproval;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
