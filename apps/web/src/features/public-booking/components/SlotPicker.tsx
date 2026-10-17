import type { PublicAvailabilityResponse, PublicSlotDto } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { CalendarSearch, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../shared/lib/cn.js';
import { Button } from '../../../shared/ui/button.js';
import { Skeleton } from '../../../shared/ui/skeleton.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import {
  addDays,
  dayLabel,
  groupByDay,
  longDayLabel,
  slotLabel,
  todayIn,
  zoneLabel,
} from '../domain/slots.js';

/** Days one screen of slots covers. The API answers up to 31 at a time. */
const PAGE_DAYS = 14;

export interface SlotPickerProps {
  /** Loads the free times between two local dates (both included). */
  load: (range: { from: string; to: string }) => Promise<PublicAvailabilityResponse>;
  /** Everything the loader depends on, so a different professional or type reloads. */
  queryKey: readonly unknown[];
  /** The zone of the location: times are shown in it, never in the device's. */
  timeZone: string;
  onPick: (slot: PublicSlotDto) => void;
  /** A slot is being held: the buttons wait. */
  pending?: boolean;
  /** Where to send a visitor when nothing is free (the waitlist), when that page exists. */
  waitlistPath?: string | undefined;
}

/**
 * The days and times a visitor can pick. Days with free times come first as buttons; the times of
 * the chosen day are a grid of buttons. When nothing is free it points at the next free time and
 * says whom to ask. Every button names the day and the time, so a screen reader hears the same
 * thing a sighted person reads.
 */
export function SlotPicker({
  load,
  queryKey,
  timeZone,
  onPick,
  pending = false,
  waitlistPath,
}: SlotPickerProps) {
  const { t } = useTranslation('booking');
  const today = useMemo(() => todayIn(timeZone, new Date()), [timeZone]);
  const [from, setFrom] = useState(today);
  // The day the visitor picked, for the page of dates it was picked on (a new page starts again).
  const [picked, setPicked] = useState<{ from: string; date: string } | null>(null);
  const chosenDay = picked?.from === from ? picked.date : null;
  const to = addDays(from, PAGE_DAYS - 1);

  const slots = useQuery({
    queryKey: [...queryKey, from],
    queryFn: () => load({ from, to }),
    staleTime: 15_000,
  });

  const days = useMemo(() => groupByDay(slots.data?.slots ?? []), [slots.data]);
  const day = days.find((entry) => entry.date === chosenDay) ?? days[0];

  const nextAvailable = slots.data?.nextAvailable ?? null;
  const zone = zoneLabel(timeZone, new Date());

  return (
    <section aria-labelledby="slots-title" className="grid gap-4">
      <div className="grid gap-1">
        <h2 id="slots-title" className="font-display text-lg font-semibold">
          {t('slots.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('slots.zone', { zone })}</p>
      </div>

      {slots.isPending ? (
        <div role="status" aria-label={t('loading')} className="grid gap-3">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : null}

      {slots.isError ? (
        <ErrorState
          error={slots.error}
          onRetry={() => {
            void slots.refetch();
          }}
        />
      ) : null}

      {slots.isSuccess && days.length === 0 ? (
        <div className="grid gap-3 rounded-lg border bg-card p-4 text-sm">
          <p className="font-medium">{t('slots.none')}</p>
          {nextAvailable ? (
            <Button
              variant="outline"
              className="justify-start whitespace-normal text-left"
              onClick={() => {
                setFrom(nextAvailable.date);
              }}
            >
              <CalendarSearch aria-hidden="true" />
              {t('slots.next', {
                when: `${longDayLabel(nextAvailable.date)}, ${slotLabel(nextAvailable.startsAt, timeZone)}`,
              })}
            </Button>
          ) : null}
          <p className="text-muted-foreground">{t('slots.contact')}</p>
          {waitlistPath ? (
            <a
              href={waitlistPath}
              className="font-medium text-primary-ink underline-offset-4 hover:underline"
            >
              {t('slots.waitlist')}
            </a>
          ) : null}
        </div>
      ) : null}

      {days.length > 0 ? (
        <>
          <ul
            aria-label={t('slots.days')}
            className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0"
          >
            {days.map((entry) => (
              <li key={entry.date} className="shrink-0">
                <Button
                  variant={entry.date === day?.date ? 'default' : 'outline'}
                  aria-pressed={entry.date === day?.date}
                  aria-label={longDayLabel(entry.date)}
                  onClick={() => {
                    setPicked({ from, date: entry.date });
                  }}
                >
                  {dayLabel(entry.date)}
                </Button>
              </li>
            ))}
          </ul>

          {day ? (
            <div className="grid gap-2">
              <h3 className="text-sm font-medium">
                {t('slots.times', { day: longDayLabel(day.date) })}
              </h3>
              <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
                {day.slots.map((slot) => (
                  <li key={slot.startsAt}>
                    <Button
                      variant="outline"
                      className={cn('tabular w-full', pending && 'cursor-wait')}
                      disabled={pending}
                      aria-label={t('slots.timeAria', {
                        day: longDayLabel(slot.date),
                        time: slotLabel(slot.startsAt, timeZone),
                      })}
                      onClick={() => {
                        onPick(slot);
                      }}
                    >
                      {slotLabel(slot.startsAt, timeZone)}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}

      {slots.isSuccess ? (
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={from <= today}
            onClick={() => {
              const earlier = addDays(from, -PAGE_DAYS);
              setFrom(earlier < today ? today : earlier);
            }}
          >
            <ChevronLeft aria-hidden="true" />
            {t('slots.earlier')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFrom(addDays(from, PAGE_DAYS));
            }}
          >
            {t('slots.more')}
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      ) : null}

      {pending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('slots.holding')}
        </p>
      ) : null}
    </section>
  );
}
