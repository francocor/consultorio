import {
  CANCELLATION_REASONS,
  CANCELLED_BY,
  type AppointmentDto,
  type CalendarEntryDto,
  type CancelledBy,
  type CancellationReason,
} from '@consultorio/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../shared/ui/button.js';
import { Select, Textarea } from '../../../../shared/ui/input.js';
import { Label } from '../../../../shared/ui/label.js';
import { useAppointmentAction } from '../../containers/use-appointment-action.js';

import { ErrorNotice } from './ErrorNotice.js';
import { PanelFrame } from './PanelFrame.js';

interface Cancellation {
  cancelledBy: CancelledBy;
  reasonCode: CancellationReason;
  note: string;
}

/**
 * Cancelling: who asked, why (a code, so reports can group them) and a note when it is "other".
 * In a read-only organization only the cancellation the patient asked for goes through (the API
 * refuses the others with 402), so that is the only one offered.
 */
export function CancelPanel({
  entry,
  readOnly,
  onBack,
  onDone,
}: {
  entry: CalendarEntryDto;
  readOnly: boolean;
  onBack: () => void;
  onDone: (updated: AppointmentDto) => void;
}) {
  const { t } = useTranslation('scheduling');
  const [by, setBy] = useState<CancelledBy | ''>('');
  const [reason, setReason] = useState<CancellationReason | ''>('');
  const [note, setNote] = useState('');

  const cancel = useAppointmentAction(
    entry,
    (api, value: Cancellation) =>
      api.cancel(entry.id, {
        cancelledBy: value.cancelledBy,
        reasonCode: value.reasonCode,
        ...(value.note.trim() === '' ? {} : { note: value.note.trim() }),
        expectedVersion: entry.version,
      }),
    (updated) => {
      onDone(updated);
    },
  );

  const cancellers = readOnly
    ? CANCELLED_BY.filter((option) => option === 'patient')
    : CANCELLED_BY;
  const needsNote = reason === 'other';
  const ready = by !== '' && reason !== '' && (!needsNote || note.trim() !== '');

  return (
    <PanelFrame title={t('drawer.cancel.title')} onBack={onBack}>
      <div className="grid gap-1.5">
        <Label htmlFor="cancel-by">{t('drawer.cancel.by')}</Label>
        <Select
          id="cancel-by"
          aria-describedby={readOnly ? 'cancel-by-read-only' : undefined}
          value={by}
          onChange={(event) => {
            setBy(event.target.value as CancelledBy | '');
          }}
        >
          <option value="" />
          {cancellers.map((option) => (
            <option key={option} value={option}>
              {t(`drawer.cancel.byOption.${option}`)}
            </option>
          ))}
        </Select>
        {readOnly ? (
          <p id="cancel-by-read-only" className="text-sm text-muted-foreground">
            {t('drawer.cancel.byReadOnly')}
          </p>
        ) : null}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="cancel-reason">{t('drawer.cancel.reason')}</Label>
        <Select
          id="cancel-reason"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value as CancellationReason | '');
          }}
        >
          <option value="" />
          {CANCELLATION_REASONS.map((option) => (
            <option key={option} value={option}>
              {t(`drawer.cancel.reasonOption.${option}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="cancel-note">{t('drawer.cancel.note')}</Label>
        <Textarea
          id="cancel-note"
          rows={2}
          maxLength={200}
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </div>
      {cancel.isError ? <ErrorNotice error={cancel.error} /> : null}
      <Button
        type="button"
        variant="destructive"
        disabled={!ready}
        loading={cancel.isPending}
        onClick={() => {
          if (by === '' || reason === '') return;
          cancel.mutate({ cancelledBy: by, reasonCode: reason, note });
        }}
      >
        {t('drawer.cancel.confirm')}
      </Button>
    </PanelFrame>
  );
}
