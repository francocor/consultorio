import { ROM_UNITS } from '@consultorio/contracts';
import { useFormContext, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../shared/lib/cn.js';

import { AreaField, FieldShell, NumberField, RepeatableRows, TextField } from './fields.js';

const PAIN_SCALE = Array.from({ length: 11 }, (_, value) => value);

/**
 * A physiotherapy session. The pain scale is a row of eleven large buttons (0 to 10): one tap on a
 * phone and no way to type a value outside the scale.
 */
export function PhysiotherapyFields({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation('clinical');
  const { control, setValue } = useFormContext();
  const pain: unknown = useWatch({ control, name: 'painIntensity' });
  const session: unknown = useWatch({ control, name: 'sessionNumber' });
  const total: unknown = useWatch({ control, name: 'totalSessions' });

  return (
    <div className="grid gap-4">
      <FieldShell name="painIntensity" label={t('field.painIntensity')} required>
        {(props) => (
          <div
            id={props.id}
            role="radiogroup"
            aria-label={t('field.painIntensity')}
            {...(props['aria-describedby']
              ? { 'aria-describedby': props['aria-describedby'] }
              : {})}
            className="grid grid-cols-6 gap-1.5 sm:grid-cols-11"
          >
            {PAIN_SCALE.map((value) => {
              const selected = pain === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={disabled}
                  onClick={() => {
                    setValue('painIntensity', value, { shouldDirty: true, shouldValidate: true });
                  }}
                  className={cn(
                    'touch-target-md cursor-pointer rounded-md border text-base font-medium transition-colors',
                    'disabled:cursor-not-allowed disabled:opacity-60',
                    selected
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'bg-card hover:bg-accent',
                  )}
                >
                  {value}
                </button>
              );
            })}
          </div>
        )}
      </FieldShell>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{t('physiotherapy.pain.none')}</span>
        <span>{t('physiotherapy.pain.worst')}</span>
      </div>

      <TextField
        name="affectedRegion"
        label={t('field.affectedRegion')}
        required
        disabled={disabled}
      />
      <RepeatableRows
        name="rangeOfMotion"
        legend={t('field.rangeOfMotion')}
        addLabel={t('physiotherapy.rom.add')}
        empty={{ joint: '', value: undefined, unit: 'deg' }}
        disabled={disabled}
        columns={[
          { key: 'joint', label: t('physiotherapy.rom.joint') },
          { key: 'value', label: t('physiotherapy.rom.value'), kind: 'number' },
          {
            key: 'unit',
            label: t('physiotherapy.rom.unit'),
            kind: 'select',
            options: ROM_UNITS.map((unit) => ({
              value: unit,
              label: t(`physiotherapy.rom.unit.${unit}`),
            })),
          },
        ]}
      />
      <AreaField
        name="functionalTests"
        label={t('field.functionalTests')}
        rows={2}
        disabled={disabled}
      />
      <AreaField name="procedures" label={t('field.procedures')} rows={2} disabled={disabled} />

      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField
          name="sessionNumber"
          label={t('field.sessionNumber')}
          required
          disabled={disabled}
        />
        <NumberField name="totalSessions" label={t('field.totalSessions')} disabled={disabled} />
      </div>
      {typeof session === 'number' && typeof total === 'number' ? (
        <p className="text-sm font-medium" aria-live="polite">
          {t('physiotherapy.session.of', { n: session, total })}
        </p>
      ) : null}
      <AreaField name="goals" label={t('field.goals')} rows={2} disabled={disabled} />
    </div>
  );
}
