import { useTranslation } from 'react-i18next';

import { AreaField, RepeatableRows, TextField } from './fields.js';

/** The generic encounter: reason, findings, measurements, diagnosis, plan and medications. */
export function GeneralFields({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation('clinical');
  return (
    <div className="grid gap-4">
      <AreaField
        name="reasonForConsultation"
        label={t('field.reasonForConsultation')}
        required
        rows={2}
        disabled={disabled}
      />
      <AreaField name="symptoms" label={t('field.symptoms')} rows={3} disabled={disabled} />
      <RepeatableRows
        name="measurements"
        legend={t('field.measurements')}
        addLabel={t('measurement.add')}
        empty={{ name: '', value: '', unit: '' }}
        disabled={disabled}
        columns={[
          { key: 'name', label: t('measurement.name') },
          { key: 'value', label: t('measurement.value') },
          { key: 'unit', label: t('measurement.unit') },
        ]}
      />
      <TextField name="diagnosis" label={t('field.diagnosis')} disabled={disabled} />
      <AreaField name="plan" label={t('field.plan')} rows={3} disabled={disabled} />
      <RepeatableRows
        name="medications"
        legend={t('field.medications')}
        addLabel={t('medication.add')}
        empty={{ name: '', dose: '', frequency: '' }}
        disabled={disabled}
        columns={[
          { key: 'name', label: t('medication.name') },
          { key: 'dose', label: t('medication.dose') },
          { key: 'frequency', label: t('medication.frequency') },
        ]}
      />
    </div>
  );
}
