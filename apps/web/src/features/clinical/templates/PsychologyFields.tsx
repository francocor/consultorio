import { PSYCHOLOGY_MODALITIES, RISK_LEVELS, type RiskLevel } from '@consultorio/contracts';
import { useFormContext, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { RadioCard, RadioGroup } from '../../../shared/ui/radio-card.js';

import { AreaField, DateField, FieldShell } from './fields.js';

function isRiskLevel(value: unknown): value is RiskLevel {
  return RISK_LEVELS.some((level) => level === value);
}

/**
 * A psychology session: date, modality, topics, observations, risk assessment and plan. A medium
 * or high risk asks for a follow-up note before the session can be signed; the draft can be saved
 * without it.
 */
export function PsychologyFields({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation('clinical');
  const { control, setValue } = useFormContext();
  const risk: unknown = useWatch({ control, name: 'risk' });
  const modality: unknown = useWatch({ control, name: 'modality' });
  const followUp: unknown = useWatch({ control, name: 'followUpNote' });
  const needsFollowUp =
    (risk === 'medium' || risk === 'high') &&
    (typeof followUp !== 'string' || followUp.trim() === '');

  const choose = (name: 'modality' | 'risk') => (value: string) => {
    setValue(name, value, { shouldDirty: true, shouldValidate: true });
  };

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{t('psychology.shared.note')}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <DateField name="sessionDate" label={t('field.sessionDate')} required disabled={disabled} />
        <FieldShell name="modality" label={t('field.modality')} required>
          {(props) => (
            <RadioGroup
              {...props}
              className="grid-cols-2"
              value={typeof modality === 'string' ? modality : ''}
              onValueChange={choose('modality')}
              disabled={disabled}
              aria-label={t('field.modality')}
            >
              {PSYCHOLOGY_MODALITIES.map((option) => (
                <RadioCard key={option} value={option} title={t(`psychology.modality.${option}`)} />
              ))}
            </RadioGroup>
          )}
        </FieldShell>
      </div>
      <AreaField name="topics" label={t('field.topics')} rows={3} disabled={disabled} />
      <AreaField name="observations" label={t('field.observations')} rows={4} disabled={disabled} />
      <FieldShell name="risk" label={t('field.risk')} required>
        {(props) => (
          <RadioGroup
            {...props}
            className="grid-cols-2 sm:grid-cols-4"
            value={typeof risk === 'string' ? risk : ''}
            onValueChange={choose('risk')}
            disabled={disabled}
            aria-label={t('field.risk')}
          >
            {RISK_LEVELS.map((level) => (
              <RadioCard key={level} value={level} title={t(`psychology.risk.${level}`)} />
            ))}
          </RadioGroup>
        )}
      </FieldShell>
      {isRiskLevel(risk) && needsFollowUp ? (
        <Alert tone="warning">
          <AlertDescription>
            {t('psychology.followUp.prompt', { level: t(`psychology.risk.${risk}`).toLowerCase() })}
          </AlertDescription>
        </Alert>
      ) : null}
      <AreaField
        name="followUpNote"
        label={t('field.followUpNote')}
        rows={3}
        disabled={disabled}
        {...(risk === 'medium' || risk === 'high' ? { required: true } : {})}
      />
      <AreaField name="plan" label={t('field.plan')} rows={3} disabled={disabled} />
    </div>
  );
}
