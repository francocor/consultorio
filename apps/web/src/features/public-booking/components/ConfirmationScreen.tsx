import type { PublicConfirmationDto } from '@consultorio/contracts';
import { CalendarCheck, CalendarClock, MapPin, UserRound, Video } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { usePageTitle } from '../../../app/use-page-title.js';
import { downloadBlob } from '../../../shared/lib/download.js';
import { Button } from '../../../shared/ui/button.js';
import { longDayLabel, slotLabel, todayIn, zoneLabel } from '../domain/slots.js';

import { DetailRow } from './DetailRow.js';

/**
 * The last screen of a booking, and of a change. It is the same for a new patient and for one the
 * organization already had: it says when, where and with whom, and nothing that reveals which it
 * was. A booking that waits for approval says so instead of "confirmed".
 */
export function ConfirmationScreen({
  confirmation,
  moved = false,
}: {
  confirmation: PublicConfirmationDto;
  /** The visitor changed the time of a booking they already had. */
  moved?: boolean;
}) {
  const { t } = useTranslation('booking');
  const pending = confirmation.status === 'pending_approval';
  const title = moved
    ? t('manage.movedTitle')
    : pending
      ? t('done.title.pending')
      : t('done.title.scheduled');
  usePageTitle(title);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const localDate = todayIn(confirmation.timeZone, new Date(confirmation.startsAt));

  return (
    <section aria-labelledby="done-title" className="grid gap-5">
      <div className="grid justify-items-start gap-3">
        <span className="grid size-12 place-content-center rounded-full bg-success-soft text-success-soft-foreground">
          <CalendarCheck className="size-6" aria-hidden="true" />
        </span>
        <h1
          id="done-title"
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-2xl font-semibold tracking-tight outline-none"
        >
          {title}
        </h1>
        <p className="text-sm text-muted-foreground">
          {pending ? t('done.description.pending') : t('done.description.scheduled')}
        </p>
      </div>

      <dl className="grid gap-4 rounded-lg border bg-card p-4 text-sm">
        <DetailRow icon={CalendarClock} label={t('done.when')}>
          {longDayLabel(localDate)}, {slotLabel(confirmation.startsAt, confirmation.timeZone)}
          <span className="block text-xs font-normal text-muted-foreground">
            {zoneLabel(confirmation.timeZone, new Date(confirmation.startsAt))}
          </span>
        </DetailRow>
        <DetailRow icon={MapPin} label={t('done.where')}>
          {confirmation.locationName}
        </DetailRow>
        <DetailRow icon={UserRound} label={t('done.who')}>
          {confirmation.professionalName}
        </DetailRow>
        <DetailRow
          icon={confirmation.mode === 'virtual' ? Video : CalendarCheck}
          label={t('done.what')}
        >
          {confirmation.typeName}
          {confirmation.mode === 'virtual' ? ` · ${t('done.virtual')}` : ''}
        </DetailRow>
      </dl>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          variant="outline"
          onClick={() => {
            downloadBlob(
              new Blob([confirmation.calendarFile], { type: 'text/calendar;charset=utf-8' }),
              'turno.ics',
            );
          }}
        >
          <CalendarClock aria-hidden="true" />
          {t('done.calendar')}
        </Button>
        {confirmation.managePath ? (
          <Button variant="ghost" asChild>
            <a href={confirmation.managePath}>{t('done.manage')}</a>
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('done.reminder')}</p>
    </section>
  );
}
