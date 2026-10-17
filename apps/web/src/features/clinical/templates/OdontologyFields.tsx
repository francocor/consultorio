import { useQuery } from '@tanstack/react-query';
import { Controller, useFormContext } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { clinicalApi, clinicalKeys } from '../api/clinical-api.js';
import { Odontogram } from '../odontogram/Odontogram.js';

import { AreaField } from './fields.js';

/** An odontology encounter: the reason, the odontogram, notes and the treatment plan. */
export function OdontologyFields({
  patientId,
  disabled = false,
}: {
  patientId: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation('clinical');
  const api = useApi();
  const { control } = useFormContext();
  // The chart as it stands from the signed entries, drawn behind what this entry records. It is a
  // convenience: without it (no access yet, a failure) the entry is still written in full.
  const current = useQuery({
    queryKey: clinicalKeys.odontogram(patientId),
    queryFn: () => clinicalApi(api).odontogram(patientId),
    retry: false,
  });

  return (
    <div className="grid gap-4">
      <AreaField
        name="reasonForConsultation"
        label={t('field.reasonForConsultation')}
        required
        rows={2}
        disabled={disabled}
      />
      <div className="grid gap-2">
        <h2 className="text-sm font-medium">{t('field.odontogram')}</h2>
        <Controller
          control={control}
          name="odontogram"
          render={({ field }) => (
            <Odontogram
              value={(field.value as Record<string, never> | undefined) ?? {}}
              {...(disabled ? {} : { onChange: field.onChange })}
              {...(current.data ? { current: current.data.teeth } : {})}
            />
          )}
        />
        {current.data && current.data.entries > 0 ? (
          <p className="text-xs text-muted-foreground">{t('odontology.chart.current')}</p>
        ) : null}
      </div>
      <AreaField name="notes" label={t('field.notes')} rows={3} disabled={disabled} />
      <AreaField
        name="treatmentPlan"
        label={t('field.treatmentPlan')}
        rows={3}
        disabled={disabled}
      />
    </div>
  );
}
