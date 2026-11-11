import type { OnboardingStateDto } from '@consultorio/contracts';
import { Check, Minus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../shared/lib/cn.js';
import { stepOf, type WizardScreen } from '../wizard-model.js';

/**
 * The steps of the wizard as a list the person can jump around in. On a phone each step is a
 * numbered circle (its name is still announced); from the tablet size up the names show.
 */
export function StepNav({
  state,
  screens,
  current,
  onSelect,
}: {
  state: OnboardingStateDto;
  screens: readonly WizardScreen[];
  current: WizardScreen;
  onSelect: (screen: WizardScreen) => void;
}) {
  const { t } = useTranslation('onboarding');
  return (
    <nav aria-label={t('progress.label')}>
      <ol className="flex flex-wrap gap-2 md:gap-1">
        {screens.map((screen, index) => {
          const step = screen === 'review' ? undefined : stepOf(state, screen);
          const status = step?.status ?? 'pending';
          const isCurrent = screen === current;
          return (
            <li key={screen}>
              <button
                type="button"
                aria-current={isCurrent ? 'step' : undefined}
                onClick={() => {
                  onSelect(screen);
                }}
                className={cn(
                  'touch-target-md inline-flex cursor-pointer items-center gap-2 rounded-md border px-2 text-sm md:px-3',
                  isCurrent
                    ? 'border-primary bg-primary-soft font-medium'
                    : 'border-transparent hover:bg-accent',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'grid size-6 shrink-0 place-content-center rounded-full border text-xs font-medium',
                    status === 'done' && 'border-success bg-success text-success-foreground',
                    status === 'skipped' && 'border-input text-muted-foreground',
                  )}
                >
                  {status === 'done' ? (
                    <Check className="size-3.5" />
                  ) : status === 'skipped' ? (
                    <Minus className="size-3.5" />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="sr-only md:not-sr-only">{t(`step.${screen}`)}</span>
                {status === 'done' ? <span className="sr-only">{t('progress.done')}</span> : null}
                {status === 'skipped' ? (
                  <span className="sr-only">{t('progress.skipped')}</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
