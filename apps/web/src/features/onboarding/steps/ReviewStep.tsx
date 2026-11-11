import type { OnboardingStateDto, WizardPrerequisite } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { CheckCircle2, Circle, MinusCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription, AlertTitle } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { toast } from '../../../shared/ui/toaster.js';
import { onboardingApi, onboardingKeys } from '../api/onboarding-api.js';
import { StepFooter } from '../components/StepFooter.js';
import type { WizardScreen } from '../wizard-model.js';

import type { StepProps } from './types.js';

/** The screen that fixes each missing piece. A missing professional is the owner's own profile, or a team invitation. */
function screenFor(item: WizardPrerequisite, state: OnboardingStateDto): WizardScreen {
  switch (item) {
    case 'location':
      return 'location';
    case 'professional':
      return state.wizard.answers.isProfessional === true ? 'profile' : 'team';
    case 'hours':
      return 'hours';
    case 'appointment_type':
      return 'appointment_types';
  }
}

const STATUS_ICON = { done: CheckCircle2, skipped: MinusCircle, pending: Circle } as const;

/** The end of the wizard: what was done, what is missing to book, and the button that finishes it. */
export function ReviewStep({ state, back, goTo }: StepProps) {
  const { t } = useTranslation(['onboarding', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [attempted, setAttempted] = useState(false);
  const { wizard } = state;

  const finish = useMutation({
    mutationFn: () => onboardingApi(api).complete(),
    onSuccess: async (updated) => {
      queryClient.setQueryData(onboardingKeys.state, updated);
      toast.success(t('onboarding:review.finished'));
      await navigate({ to: '/' });
    },
    onError: async (error) => {
      // The server is the judge: refresh what is missing and show it.
      if (isApiError(error) && error.status === 400) setAttempted(true);
      await queryClient.invalidateQueries({ queryKey: onboardingKeys.state });
    },
  });

  const blocked = wizard.missing.length > 0;
  const rejectedForOtherReasons =
    finish.isError && !(isApiError(finish.error) && finish.error.status === 400);

  return (
    <div className="grid gap-5">
      <p className="text-sm text-muted-foreground">
        {wizard.completed ? t('onboarding:review.completed') : t('onboarding:review.description')}
      </p>

      <ul className="grid gap-2">
        {wizard.steps.map((step) => {
          const Icon = STATUS_ICON[step.status];
          return (
            <li key={step.id} className="flex items-center gap-3 rounded-md border p-3 text-sm">
              <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="flex-1 font-medium">{t(`onboarding:step.${step.id}`)}</span>
              <span className="text-muted-foreground">
                {step.status === 'done'
                  ? t('onboarding:progress.done')
                  : step.status === 'skipped'
                    ? t('onboarding:progress.skipped')
                    : step.required
                      ? t('onboarding:progress.required')
                      : t('onboarding:checklist.pending')}
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`${t('onboarding:review.goTo')}: ${t(`onboarding:step.${step.id}`)}`}
                onClick={() => {
                  goTo(step.id);
                }}
              >
                {t('common:action.edit')}
              </Button>
            </li>
          );
        })}
      </ul>

      {rejectedForOtherReasons ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, finish.error).message}</AlertDescription>
        </Alert>
      ) : null}

      {blocked && !wizard.completed ? (
        <Alert tone={attempted ? 'danger' : 'warning'}>
          <AlertTitle>{t('onboarding:review.blocked')}</AlertTitle>
          <AlertDescription>
            <ul className="grid gap-1">
              {wizard.missing.map((item) => (
                <li key={item} className="flex flex-wrap items-center gap-x-3">
                  <span>{t(`onboarding:missing.${item}`)}</span>
                  <Button
                    variant="link"
                    size="sm"
                    aria-label={`${t('onboarding:review.goTo')}: ${t(`onboarding:missing.${item}`)}`}
                    onClick={() => {
                      goTo(screenFor(item, state));
                    }}
                  >
                    {t('onboarding:review.goTo')}
                  </Button>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {wizard.completed ? (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          {back ? (
            <Button variant="outline" onClick={back}>
              {t('onboarding:action.back')}
            </Button>
          ) : null}
          <Button asChild>
            <Link to="/">{t('common:action.continue')}</Link>
          </Button>
        </div>
      ) : (
        <StepFooter
          onBack={back}
          pending={finish.isPending}
          continueLabel={t('onboarding:review.finish')}
          onContinue={() => {
            finish.mutate();
          }}
        />
      )}
    </div>
  );
}
