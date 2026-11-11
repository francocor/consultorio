import type { AppointmentDto, CalendarEntryDto } from '@consultorio/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../shared/ui/button.js';
import { Checkbox } from '../../../../shared/ui/checkbox.js';
import { Label } from '../../../../shared/ui/label.js';
import { useAppointmentAction } from '../../containers/use-appointment-action.js';

import { ErrorNotice } from './ErrorNotice.js';
import { PanelFrame } from './PanelFrame.js';

/**
 * The arrival of the patient. When the identity is still unconfirmed this asks the person to
 * look at the patient and the ID document and say so. For the appointment's own professional the
 * wording is the solo-practice one: the API accepts that confirmation only when they are the only
 * person who could give it, and says so otherwise.
 */
export function CheckInPanel({
  entry,
  isOwnProfessional,
  onBack,
  onDone,
}: {
  entry: CalendarEntryDto;
  isOwnProfessional: boolean;
  onBack: () => void;
  onDone: (updated: AppointmentDto, asked: boolean) => void;
}) {
  const { t } = useTranslation('scheduling');
  const [confirmed, setConfirmed] = useState(false);
  const checkIn = useAppointmentAction(
    entry,
    (api, asked: boolean) =>
      api.checkIn(entry.id, {
        expectedVersion: entry.version,
        ...(asked ? { confirmIdentity: true } : {}),
      }),
    (updated, asked) => {
      onDone(updated, asked);
    },
  );

  const mode = isOwnProfessional ? 'own' : 'staff';

  return (
    <PanelFrame title={t('drawer.checkIn.title')} onBack={onBack}>
      <p className="text-sm text-muted-foreground">{t(`drawer.checkIn.${mode}.intro`)}</p>
      <div className="flex items-start gap-2">
        <Checkbox
          id="check-in-identity"
          checked={confirmed}
          onCheckedChange={(value) => {
            setConfirmed(value === true);
          }}
        />
        <Label htmlFor="check-in-identity" className="font-normal leading-snug">
          {t(`drawer.checkIn.${mode}.checkbox`)}
        </Label>
      </div>
      {checkIn.isError ? <ErrorNotice error={checkIn.error} /> : null}
      <Button
        type="button"
        loading={checkIn.isPending}
        onClick={() => {
          checkIn.mutate(confirmed);
        }}
      >
        {t('drawer.checkIn.confirm')}
      </Button>
    </PanelFrame>
  );
}
