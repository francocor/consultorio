import type { WaitlistTimeRange } from '@consultorio/contracts';
import { Plus, Trash2 } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../shared/ui/button.js';
import { Input } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import {
  AFTERNOON,
  MORNING,
  WEEKDAYS,
  rangeProblem,
  toggleDay,
  weekdayName,
} from '../domain/preferences.js';

/** When the patient can come, as the screens edit it. The time inputs may be half typed. */
export interface Preferences {
  weekdays: number[];
  timeRanges: { from: string; to: string }[];
  earliestDate: string;
  latestDate: string;
}

export const NO_PREFERENCES: Preferences = {
  weekdays: [],
  timeRanges: [],
  earliestDate: '',
  latestDate: '',
};

/** Whether the preferences can be sent: every range has two limits and ends after it starts. */
export function preferencesProblem(value: Preferences): string | null {
  if (value.timeRanges.some((range) => rangeProblem(range) !== null)) return 'ranges';
  if (
    value.earliestDate !== '' &&
    value.latestDate !== '' &&
    value.earliestDate > value.latestDate
  ) {
    return 'dates';
  }
  return null;
}

/** The request fields of the preferences. */
export function preferencesBody(value: Preferences) {
  return {
    weekdays: value.weekdays,
    timeRanges: value.timeRanges as WaitlistTimeRange[],
    earliestDate: value.earliestDate === '' ? null : value.earliestDate,
    latestDate: value.latestDate === '' ? null : value.latestDate,
  };
}

/**
 * The days, the hours and the dates the patient can come. Nothing chosen means "any": the fields
 * say so, so an empty form is not read as "never". Every control has a visible label.
 */
export function PreferencesFields({
  value,
  onChange,
  idPrefix,
}: {
  value: Preferences;
  onChange: (next: Preferences) => void;
  idPrefix?: string;
}) {
  const { t } = useTranslation('waitlist');
  const generated = useId();
  const prefix = idPrefix ?? generated;
  const problem = preferencesProblem(value);

  function setRange(index: number, patch: Partial<{ from: string; to: string }>) {
    onChange({
      ...value,
      timeRanges: value.timeRanges.map((range, at) =>
        at === index ? { ...range, ...patch } : range,
      ),
    });
  }

  return (
    <div className="grid gap-4">
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{t('prefs.days.legend')}</legend>
        <p className="text-sm text-muted-foreground">{t('prefs.days.hint')}</p>
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS.map((day) => {
            const id = `${prefix}-day-${String(day)}`;
            const checked = value.weekdays.includes(day);
            return (
              <div key={day}>
                <input
                  id={id}
                  type="checkbox"
                  className="peer sr-only"
                  checked={checked}
                  onChange={() => {
                    onChange({ ...value, weekdays: toggleDay(value.weekdays, day) });
                  }}
                />
                <label
                  htmlFor={id}
                  aria-label={weekdayName(day, 'long')}
                  className="touch-target-md inline-flex min-w-12 cursor-pointer items-center justify-center rounded-md border border-input bg-card px-3 text-sm font-medium capitalize peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2"
                >
                  {weekdayName(day, 'short')}
                </label>
              </div>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{t('prefs.times.legend')}</legend>
        <p className="text-sm text-muted-foreground">{t('prefs.times.hint')}</p>
        {value.timeRanges.length > 0 ? (
          <ul className="grid gap-2">
            {value.timeRanges.map((range, index) => {
              const fromId = `${prefix}-from-${String(index)}`;
              const toId = `${prefix}-to-${String(index)}`;
              const invalid = rangeProblem(range) !== null;
              return (
                <li key={index} className="flex flex-wrap items-end gap-2">
                  <div className="grid gap-1">
                    <Label htmlFor={fromId}>{t('prefs.times.from')}</Label>
                    <Input
                      id={fromId}
                      type="time"
                      value={range.from}
                      aria-invalid={invalid}
                      className="w-32"
                      onChange={(event) => {
                        setRange(index, { from: event.target.value });
                      }}
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor={toId}>{t('prefs.times.to')}</Label>
                    <Input
                      id={toId}
                      type="time"
                      value={range.to}
                      aria-invalid={invalid}
                      className="w-32"
                      onChange={(event) => {
                        setRange(index, { to: event.target.value });
                      }}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('prefs.times.remove', { number: index + 1 })}
                    onClick={() => {
                      onChange({
                        ...value,
                        timeRanges: value.timeRanges.filter((_, at) => at !== index),
                      });
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['morning', MORNING],
              ['afternoon', AFTERNOON],
            ] as const
          ).map(([name, range]) => (
            <Button
              key={name}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                onChange({ ...value, timeRanges: [...value.timeRanges, { ...range }] });
              }}
            >
              <Plus aria-hidden="true" />
              {t(`prefs.times.add.${name}`)}
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              onChange({ ...value, timeRanges: [...value.timeRanges, { from: '', to: '' }] });
            }}
          >
            <Plus aria-hidden="true" />
            {t('prefs.times.add.other')}
          </Button>
        </div>
        {problem === 'ranges' ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {t('prefs.times.invalid')}
          </p>
        ) : null}
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{t('prefs.dates.legend')}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor={`${prefix}-earliest`}>{t('prefs.dates.earliest')}</Label>
            <Input
              id={`${prefix}-earliest`}
              type="date"
              value={value.earliestDate}
              onChange={(event) => {
                onChange({ ...value, earliestDate: event.target.value });
              }}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${prefix}-latest`}>{t('prefs.dates.latest')}</Label>
            <Input
              id={`${prefix}-latest`}
              type="date"
              value={value.latestDate}
              aria-invalid={problem === 'dates'}
              onChange={(event) => {
                onChange({ ...value, latestDate: event.target.value });
              }}
            />
          </div>
        </div>
        {problem === 'dates' ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {t('prefs.dates.invalid')}
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}
