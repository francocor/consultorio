import { APPOINTMENT_STATUSES } from '@consultorio/contracts';
import { useTranslation } from 'react-i18next';

import { Badge } from '../../../shared/ui/badge.js';
import { STATUS_PRESENTATION, statusLabel } from '../domain/calendar-events.js';

/**
 * What each status looks like: an icon and a word, never a color alone. Open on a wide screen,
 * folded away on a phone where the room is needed for the agenda.
 */
export function StatusLegend({ open }: { open: boolean }) {
  const { t } = useTranslation('scheduling');

  return (
    <details open={open} className="rounded-lg border bg-card px-3 py-2 text-sm">
      <summary className="touch-target-md flex cursor-pointer items-center font-medium">
        {t('legend.title')}
      </summary>
      <ul aria-label={t('legend.list')} className="flex flex-wrap gap-2 pb-1 pt-2">
        {APPOINTMENT_STATUSES.map((status) => {
          const { icon: Icon, tone } = STATUS_PRESENTATION[status];
          return (
            <li key={status}>
              <Badge tone={tone}>
                <Icon aria-hidden="true" />
                {statusLabel(t, status)}
              </Badge>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
