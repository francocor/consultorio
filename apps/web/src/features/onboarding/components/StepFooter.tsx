import { useTranslation } from 'react-i18next';

import { Button } from '../../../shared/ui/button.js';

/**
 * The buttons that close a step. "Guardar y continuar" is the main action (the submit of the
 * step's form); a required step has no skip; "Volver" moves back without saving.
 */
export function StepFooter({
  onBack,
  onSkip,
  skipping = false,
  pending = false,
  continueLabel,
  continueDisabled = false,
  onContinue,
}: {
  onBack?: (() => void) | undefined;
  /** Only optional steps pass this. */
  onSkip?: (() => void) | undefined;
  skipping?: boolean;
  pending?: boolean;
  continueLabel?: string;
  continueDisabled?: boolean;
  /** Without it the button submits the form it sits in. */
  onContinue?: () => void;
}) {
  const { t } = useTranslation('onboarding');
  return (
    <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        {onBack ? (
          <Button variant="outline" onClick={onBack}>
            {t('action.back')}
          </Button>
        ) : null}
        {onSkip ? (
          <Button variant="ghost" loading={skipping} onClick={onSkip}>
            {t('action.skip')}
          </Button>
        ) : null}
      </div>
      <Button
        {...(onContinue
          ? { type: 'button' as const, onClick: onContinue }
          : { type: 'submit' as const })}
        loading={pending}
        disabled={continueDisabled}
      >
        {continueLabel ?? t('action.save')}
      </Button>
    </div>
  );
}
