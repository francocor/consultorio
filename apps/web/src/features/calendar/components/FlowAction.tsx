import type { CalendarEntryDto } from '@consultorio/contracts';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../shared/ui/button.js';
import { toast } from '../../../shared/ui/toaster.js';
import type { SimpleTransition } from '../api/calendar-api.js';
import { useAppointmentAction } from '../containers/use-appointment-action.js';

import { ErrorNotice } from './drawer/ErrorNotice.js';

type Step = SimpleTransition | 'check-in';

const MESSAGE: Record<Step, string> = {
  confirm: 'confirm',
  approve: 'approve',
  start: 'start',
  attend: 'attend',
  'no-show': 'no_show',
  'check-in': 'check_in',
};

/**
 * A one-click lifecycle step on a row of the day (call the patient in, finish, register the
 * arrival), sent with the version the row shows. The API decides if it is still valid.
 */
export function FlowAction({
  entry,
  step,
  label,
  variant = 'default',
  size = 'default',
  beforeRun,
}: {
  entry: CalendarEntryDto;
  step: Step;
  label: string;
  variant?: 'default' | 'secondary' | 'outline';
  size?: 'default' | 'lg';
  /** Return `false` to handle the click elsewhere (for example, to ask for more first). */
  beforeRun?: () => boolean;
}) {
  const { t } = useTranslation('scheduling');
  const action = useAppointmentAction(entry, (client, value: Step) =>
    value === 'check-in'
      ? client.checkIn(entry.id, { expectedVersion: entry.version })
      : client.transition(entry.id, value, entry.version),
  );

  return (
    <div className="grid gap-1">
      <Button
        type="button"
        variant={variant}
        size={size}
        loading={action.isPending}
        onClick={() => {
          if (beforeRun && !beforeRun()) return;
          action.mutate(step, {
            onSuccess: () => {
              toast.success(t(`drawer.done.${MESSAGE[step]}`));
            },
          });
        }}
      >
        {label}
      </Button>
      {action.isError ? <ErrorNotice error={action.error} /> : null}
    </div>
  );
}
