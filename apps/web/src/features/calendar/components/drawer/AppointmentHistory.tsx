import type { AppointmentEventDto, AppointmentHistoryResponse } from '@consultorio/contracts';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { formatDateTime } from '../../../../shared/lib/format.js';
import { statusLabel } from '../../domain/calendar-events.js';

function eventLabel(t: TFunction, event: AppointmentEventDto): string {
  const from = event.fromStatus === null ? '' : statusLabel(t, event.fromStatus);
  const to = event.toStatus === null ? '' : statusLabel(t, event.toStatus);
  switch (event.kind) {
    case 'created':
      return t('scheduling:drawer.history.created');
    case 'status_changed':
      return t('scheduling:drawer.history.statusChanged', { from, to });
    case 'rescheduled':
      return t('scheduling:drawer.history.rescheduled');
    case 'reassigned':
      return t('scheduling:drawer.history.reassigned');
    case 'status_corrected':
      return t('scheduling:drawer.history.statusCorrected', { from, to });
    case 'identity_confirmed':
      return t('scheduling:drawer.history.identityConfirmed');
    case 'identity_rejected':
      return t('scheduling:drawer.history.identityRejected');
  }
}

/** What happened to the appointment, oldest first, with who did it and when (location time). */
export function AppointmentHistory({
  history,
  timeZone,
}: {
  history: AppointmentHistoryResponse;
  timeZone: string;
}) {
  const { t } = useTranslation('scheduling');

  return (
    <section className="grid gap-2" aria-labelledby="appointment-history-title">
      <h3 id="appointment-history-title" className="font-display text-base font-semibold">
        {t('drawer.history.title')}
      </h3>
      {history.rescheduledCount > 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('drawer.history.rescheduledCount', { count: history.rescheduledCount })}
        </p>
      ) : null}
      <ol aria-label={t('drawer.history.list')} className="grid gap-2">
        {history.events.map((event) => (
          <li key={event.id} className="rounded-md border bg-card px-3 py-2 text-sm">
            <p className="font-medium">{eventLabel(t, event)}</p>
            <p className="text-muted-foreground">
              {t(`drawer.history.actor.${event.actorKind}`)}
              {' · '}
              <time dateTime={event.at}>{formatDateTime(event.at, { timeZone })}</time>
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
