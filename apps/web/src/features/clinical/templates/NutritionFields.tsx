import { PLAUSIBLE_LIMITS, computeBmi } from '@consultorio/contracts';
import { useFormContext, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { formatNumber } from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { CheckboxCard } from '../../../shared/ui/checkbox-card.js';

import { AreaField, NumberField } from './fields.js';

function outside(value: unknown, limits: { min: number; max: number }): boolean {
  return typeof value === 'number' && (value < limits.min || value > limits.max);
}

/**
 * A nutrition visit. The body mass index is shown as soon as weight and height are there and can
 * not be edited: the server computes it too. A value outside the plausible range asks for an
 * explicit confirmation instead of blocking a real, unusual patient.
 */
export function NutritionFields({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation('clinical');
  const { control, setValue } = useFormContext();
  const weight: unknown = useWatch({ control, name: 'weightKg' });
  const height: unknown = useWatch({ control, name: 'heightM' });
  const waist: unknown = useWatch({ control, name: 'waistCm' });
  const confirmed: unknown = useWatch({ control, name: 'confirmImplausible' });
  const bmi = computeBmi(
    typeof weight === 'number' ? weight : undefined,
    typeof height === 'number' ? height : undefined,
  );
  const unusual =
    outside(weight, PLAUSIBLE_LIMITS.weightKg) ||
    outside(height, PLAUSIBLE_LIMITS.heightM) ||
    outside(waist, PLAUSIBLE_LIMITS.waistCm);

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <NumberField name="weightKg" label={t('field.weightKg')} required disabled={disabled} />
        <NumberField name="heightM" label={t('field.heightM')} required disabled={disabled} />
        <NumberField name="waistCm" label={t('field.waistCm')} disabled={disabled} />
      </div>
      <div className="rounded-md border bg-muted/40 p-3" aria-live="polite">
        <p className="text-sm font-medium">{t('nutrition.bmi')}</p>
        <p className="font-display text-2xl font-semibold">
          {bmi === null ? t('nutrition.bmi.empty') : formatNumber(bmi)}
        </p>
        <p className="text-sm text-muted-foreground">{t('nutrition.bmi.help')}</p>
      </div>
      {unusual ? (
        <Alert tone="warning">
          <AlertDescription className="grid gap-3">
            <p>{t('nutrition.implausible')}</p>
            <CheckboxCard
              checked={confirmed === true}
              disabled={disabled}
              onCheckedChange={(checked) => {
                setValue('confirmImplausible', checked, {
                  shouldDirty: true,
                  shouldValidate: true,
                });
              }}
              title={t('field.confirmImplausible')}
            />
          </AlertDescription>
        </Alert>
      ) : null}
      <AreaField
        name="dietaryHabits"
        label={t('field.dietaryHabits')}
        rows={3}
        disabled={disabled}
      />
      <AreaField
        name="allergiesIntolerances"
        label={t('field.allergiesIntolerances')}
        rows={2}
        disabled={disabled}
      />
      <AreaField name="goals" label={t('field.goals')} rows={2} disabled={disabled} />
      <AreaField name="mealPlan" label={t('field.mealPlan')} rows={5} disabled={disabled} />
    </div>
  );
}
