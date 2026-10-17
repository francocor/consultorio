import type { AppointmentDto, AppointmentStatus, CalendarEntryDto } from '@consultorio/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../shared/ui/button.js';
import { Select, Textarea } from '../../../../shared/ui/input.js';
import { Label } from '../../../../shared/ui/label.js';
import { useAppointmentAction } from '../../containers/use-appointment-action.js';
import { correctionTargets } from '../../domain/appointment-actions.js';
import { statusLabel } from '../../domain/calendar-events.js';

import { ErrorNotice } from './ErrorNotice.js';
import { PanelFrame } from './PanelFrame.js';

interface Correction {
  toStatus: AppointmentStatus;
  reason: string;
}

/**
 * Correcting a closed appointment (a no-show marked by mistake). It needs a reason, which is
 * audited. The statuses offered are the ones this person may correct to; a refusal from the API
 * (403) is explained in the panel.
 */
export function CorrectPanel({
  entry,
  isOwnProfessional,
  onBack,
  onDone,
}: {
  entry: CalendarEntryDto;
  isOwnProfessional: boolean;
  onBack: () => void;
  onDone: (updated: AppointmentDto) => void;
}) {
  const { t } = useTranslation('scheduling');
  const targets = correctionTargets(entry.status, { isOwnProfessional });
  const [chosen, setChosen] = useState<AppointmentStatus | ''>('');
  const [reason, setReason] = useState('');
  const toStatus = chosen === '' ? targets[0] : chosen;

  const correct = useAppointmentAction(
    entry,
    (api, value: Correction) =>
      api.correct(entry.id, {
        toStatus: value.toStatus,
        reason: value.reason.trim(),
        expectedVersion: entry.version,
      }),
    (updated) => {
      onDone(updated);
    },
  );

  return (
    <PanelFrame title={t('drawer.correct.title')} onBack={onBack}>
      <p className="text-sm text-muted-foreground">{t('drawer.correct.intro')}</p>
      <div className="grid gap-1.5">
        <Label htmlFor="correct-status">{t('drawer.correct.status')}</Label>
        <Select
          id="correct-status"
          value={toStatus ?? ''}
          onChange={(event) => {
            setChosen(event.target.value as AppointmentStatus);
          }}
        >
          {targets.map((status) => (
            <option key={status} value={status}>
              {statusLabel(t, status)}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="correct-reason">{t('drawer.correct.reason')}</Label>
        <Textarea
          id="correct-reason"
          rows={2}
          maxLength={200}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </div>
      {correct.isError ? <ErrorNotice error={correct.error} /> : null}
      <Button
        type="button"
        disabled={toStatus === undefined || reason.trim() === ''}
        loading={correct.isPending}
        onClick={() => {
          if (toStatus === undefined) return;
          correct.mutate({ toStatus, reason });
        }}
      >
        {t('drawer.correct.confirm')}
      </Button>
    </PanelFrame>
  );
}
