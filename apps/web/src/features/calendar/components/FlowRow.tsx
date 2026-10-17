import type { CalendarEntryDto } from '@consultorio/contracts';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { formatTime } from '../../../shared/lib/format.js';
import { Badge } from '../../../shared/ui/badge.js';
import { STATUS_PRESENTATION, statusLabel } from '../domain/calendar-events.js';

/**
 * One appointment of the day as a large, tappable row. The row opens the appointment; an optional
 * action (call the patient in, register the arrival) sits beside it as a button of its own, so no
 * control is nested inside another.
 */
export function FlowRow({
  entry,
  timeZone,
  professionalName,
  action,
  onOpen,
}: {
  entry: CalendarEntryDto;
  timeZone: string;
  /** Shown when the day mixes professionals (the front desk). */
  professionalName?: string | undefined;
  action?: ReactNode;
  onOpen: () => void;
}) {
  const { t } = useTranslation('scheduling');
  const { icon: Icon, tone } = STATUS_PRESENTATION[entry.status];

  return (
    <li className="flex flex-wrap items-stretch gap-2 rounded-lg border bg-card">
      <button
        type="button"
        onClick={onOpen}
        className="touch-target-md grid min-w-0 flex-1 basis-56 cursor-pointer grid-cols-[3.5rem_1fr] items-start gap-3 rounded-lg p-3 text-left hover:bg-accent"
      >
        <span className="tabular text-sm font-semibold">
          {formatTime(entry.startsAt, { timeZone })}
        </span>
        <span className="grid min-w-0 gap-1">
          <span className="truncate font-medium">{entry.patientName}</span>
          <span className="truncate text-sm text-muted-foreground">
            {[entry.typeName, professionalName].filter((part) => part !== undefined).join(' · ')}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={tone}>
              <Icon aria-hidden="true" />
              {statusLabel(t, entry.status)}
            </Badge>
            {entry.identityConfirmed ? null : (
              <Badge tone="warning">{t('event.identityPending')}</Badge>
            )}
          </span>
        </span>
      </button>
      {action ? <div className="flex items-center gap-2 p-2 sm:pr-3">{action}</div> : null}
    </li>
  );
}
