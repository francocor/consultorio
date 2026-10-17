import type { CalendarEntryDto } from '@consultorio/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../shared/lib/cn.js';
import { Button, buttonVariants } from '../../../shared/ui/button.js';
import { useAppointmentAction } from '../containers/use-appointment-action.js';

import { ErrorNotice } from './drawer/ErrorNotice.js';

/**
 * "Iniciar consulta": the way from an appointment to its encounter. While the patient waits, it
 * calls them in (the appointment moves to "in progress") and opens `/encounters/new` tied to the
 * appointment; while the visit is in progress it is the link to the same page.
 */
export function StartConsultation({
  entry,
  step,
  size = 'default',
}: {
  entry: CalendarEntryDto;
  step: 'start' | 'open';
  size?: 'default' | 'lg';
}) {
  const { t } = useTranslation('scheduling');
  const navigate = useNavigate();
  const target = {
    to: '/encounters/new',
    search: { patientId: entry.patientId, appointmentId: entry.id },
  } as const;
  const start = useAppointmentAction(
    entry,
    (client) => client.transition(entry.id, 'start', entry.version),
    () => {
      void navigate(target);
    },
  );

  if (step === 'open') {
    return (
      <Link {...target} className={cn(buttonVariants({ variant: 'default', size }))}>
        {t('drawer.action.start')}
      </Link>
    );
  }
  return (
    <div className="grid gap-1">
      <Button
        type="button"
        size={size}
        loading={start.isPending}
        onClick={() => {
          start.mutate();
        }}
      >
        {t('drawer.action.start')}
      </Button>
      {start.isError ? <ErrorNotice error={start.error} /> : null}
    </div>
  );
}
