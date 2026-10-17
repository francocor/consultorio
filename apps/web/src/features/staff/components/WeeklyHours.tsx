import type { LocationDto, WeeklyInterval } from '@consultorio/contracts';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../shared/ui/button.js';
import { Input } from '../../../shared/ui/input.js';
import { toMinutes, validateIntervals, type DayInterval } from '../domain/hours.js';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

interface Slot extends DayInterval {
  key: number;
  locationId: string;
  weekday: number;
}

let nextKey = 0;
const keyed = (rows: readonly WeeklyInterval[]): Slot[] =>
  rows
    .map((row) => ({ ...row, key: (nextKey += 1) }))
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));

/**
 * The weekly schedule of a professional, location by location (each in its own time zone).
 * Phone friendly: each day is a short block with its intervals stacked, never a wide grid.
 * Nothing is sent until the form is saved, and an invalid interval blocks the save with a
 * message next to it.
 */
export function WeeklyHours({
  locations,
  rows,
  saving,
  onSave,
}: {
  locations: readonly LocationDto[];
  rows: readonly WeeklyInterval[];
  saving: boolean;
  onSave: (rows: WeeklyInterval[]) => void;
}) {
  const { t } = useTranslation('staff');
  const [slots, setSlots] = useState<Slot[]>(() => keyed(rows));
  const [showErrors, setShowErrors] = useState(false);

  const problemOf = (slot: Slot) => {
    const sameDay = slots.filter(
      (other) => other.locationId === slot.locationId && other.weekday === slot.weekday,
    );
    return validateIntervals(sameDay)[sameDay.indexOf(slot)] ?? null;
  };
  const invalid = slots.some((slot) => problemOf(slot) !== null);

  function update(key: number, patch: Partial<DayInterval>) {
    setSlots((current) => current.map((slot) => (slot.key === key ? { ...slot, ...patch } : slot)));
  }

  return (
    <form
      noValidate
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        setShowErrors(true);
        if (invalid) return;
        onSave(
          [...slots]
            .sort(
              (a, b) =>
                a.locationId.localeCompare(b.locationId) ||
                a.weekday - b.weekday ||
                toMinutes(a.start) - toMinutes(b.start),
            )
            .map(({ locationId, weekday, start, end }) => ({ locationId, weekday, start, end })),
        );
      }}
    >
      {locations.map((place) => (
        <fieldset
          key={place.id}
          aria-label={t('hours.location', { name: place.name })}
          className="grid gap-3 rounded-lg border p-4"
        >
          <div className="grid gap-0.5">
            <p className="font-medium">{t('hours.location', { name: place.name })}</p>
            <p className="text-xs text-muted-foreground">
              {t('hours.timeZone', { zone: place.timeZone })}
            </p>
          </div>
          <ul className="grid gap-3">
            {WEEKDAYS.map((weekday) => {
              const day = t(`weekday.${String(weekday)}`);
              const daySlots = slots.filter(
                (slot) => slot.locationId === place.id && slot.weekday === weekday,
              );
              return (
                <li
                  key={weekday}
                  className="grid gap-2 border-t pt-3 first:border-t-0 first:pt-0 sm:grid-cols-[7rem_1fr] sm:items-start"
                >
                  <p className="pt-2 text-sm font-medium">{day}</p>
                  <div className="grid gap-2">
                    {daySlots.length === 0 ? (
                      <p className="pt-2 text-sm text-muted-foreground">{t('hours.closed')}</p>
                    ) : null}
                    {daySlots.map((slot, index) => {
                      const suffix = daySlots.length > 1 ? ` ${String(index + 1)}` : '';
                      const problem = showErrors ? problemOf(slot) : null;
                      return (
                        <div key={slot.key} className="grid gap-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Input
                              type="time"
                              step={300}
                              className="w-32"
                              aria-label={t('hours.startLabel', { day: `${day}${suffix}` })}
                              aria-invalid={problem ? true : undefined}
                              value={slot.start}
                              onChange={(event) => {
                                update(slot.key, { start: event.target.value });
                              }}
                            />
                            <span aria-hidden="true">–</span>
                            <Input
                              type="time"
                              step={300}
                              className="w-32"
                              aria-label={t('hours.endLabel', { day: `${day}${suffix}` })}
                              aria-invalid={problem ? true : undefined}
                              value={slot.end}
                              onChange={(event) => {
                                update(slot.key, { end: event.target.value });
                              }}
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t('hours.remove', {
                                day,
                                start: slot.start,
                                end: slot.end,
                              })}
                              onClick={() => {
                                setSlots((current) =>
                                  current.filter((item) => item.key !== slot.key),
                                );
                              }}
                            >
                              <Trash2 aria-hidden="true" />
                            </Button>
                          </div>
                          {problem ? (
                            <p className="text-sm font-medium text-destructive">
                              {t(`hours.error.${problem}`)}
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="justify-self-start"
                      aria-label={t('hours.addLabel', { day })}
                      onClick={() => {
                        setSlots((current) => [
                          ...current,
                          {
                            key: (nextKey += 1),
                            locationId: place.id,
                            weekday,
                            start: '09:00',
                            end: '13:00',
                          },
                        ]);
                      }}
                    >
                      <Plus aria-hidden="true" />
                      {t('hours.add')}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </fieldset>
      ))}
      <Button type="submit" loading={saving} className="justify-self-start">
        {t('hours.save')}
      </Button>
    </form>
  );
}
