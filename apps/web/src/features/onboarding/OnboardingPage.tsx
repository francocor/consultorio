import type { OnboardingStateDto, UpdateOnboardingStateRequest } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { Rocket, Workflow } from 'lucide-react';
import { useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';

import { RequirePermission } from '../../app/guards.js';
import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { Button } from '../../shared/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../shared/ui/card.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../shared/ui/states/loading-skeleton.js';

import { onboardingApi, onboardingKeys } from './api/onboarding-api.js';
import { StepNav } from './components/StepNav.js';
import { FastPathDone, FastPathForm } from './FastPath.js';
import { TrialCard } from './signup/index.js';
import { AppointmentTypesStep } from './steps/AppointmentTypesStep.js';
import { BrandingStep } from './steps/BrandingStep.js';
import { HoursStep } from './steps/HoursStep.js';
import { LocationStep } from './steps/LocationStep.js';
import { ProfileStep } from './steps/ProfileStep.js';
import { ReviewStep } from './steps/ReviewStep.js';
import { TeamStep } from './steps/TeamStep.js';
import type { StepProps } from './steps/types.js';
import { useOnboardingState } from './use-onboarding-state.js';
import {
  isFreshStart,
  isWizardScreen,
  openingScreen,
  screenAfter,
  screenBefore,
  screensOf,
  type WizardScreen,
} from './wizard-model.js';

/** `billing` has no screen yet: the API lists it only once billing exists, and the wizard skips it. */
const SCREENS: Partial<Record<WizardScreen, ComponentType<StepProps>>> = {
  profile: ProfileStep,
  location: LocationStep,
  hours: HoursStep,
  appointment_types: AppointmentTypesStep,
  team: TeamStep,
  branding: BrandingStep,
  review: ReviewStep,
};

/** The setup wizard of a new organization (tenant-onboarding, "Setup wizard"), also reachable later. */
export function OnboardingPage() {
  return (
    <RequirePermission anyOf={['onboarding.manage']}>
      <Onboarding />
    </RequirePermission>
  );
}

function Onboarding() {
  const { t } = useTranslation(['onboarding', 'common']);
  usePageTitle(t('onboarding:title'));
  const state = useOnboardingState();
  const search: unknown = useRouterState({ select: (router) => router.location.search as unknown });
  const asked =
    typeof search === 'object' && search !== null && 'step' in search ? search.step : undefined;
  const requested = typeof asked === 'string' && isWizardScreen(asked) ? asked : undefined;

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <PageHeader
        title={t('onboarding:title')}
        description={t('onboarding:description')}
        className="mb-0"
        actions={
          <Button asChild variant="ghost">
            <Link to="/">{t('onboarding:action.later')}</Link>
          </Button>
        }
      />
      {state.isPending ? (
        <FormSkeleton fields={4} />
      ) : state.isError ? (
        <ErrorState
          error={state.error}
          onRetry={() => {
            void state.refetch();
          }}
        />
      ) : (
        // A link to another step (from the checklist) opens that step: a new key starts over there.
        <>
          <TrialCard />
          <Wizard key={requested ?? 'resume'} state={state.data} requested={requested} />
        </>
      )}
    </div>
  );
}

type Mode = 'chooser' | 'fast' | 'fast-done' | 'steps';

function Wizard({
  state,
  requested,
}: {
  state: OnboardingStateDto;
  requested: WizardScreen | undefined;
}) {
  const { t } = useTranslation('onboarding');
  const api = useApi();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>(() =>
    requested === undefined && isFreshStart(state) ? 'chooser' : 'steps',
  );
  const [screen, setScreen] = useState<WizardScreen>(() => openingScreen(state, requested));

  const save = useMutation({
    mutationFn: (body: UpdateOnboardingStateRequest) => onboardingApi(api).update(body),
    onSuccess: (updated) => {
      queryClient.setQueryData(onboardingKeys.state, updated);
    },
  });

  const screens = screensOf(state);
  const index = screens.indexOf(screen);

  /** Records how the screen ended (when it matters), moves the cursor and opens the next screen. */
  async function leave(status?: 'done' | 'skipped'): Promise<void> {
    const after = screenAfter(screens, screen);
    const cursor = after !== null && after !== 'review' ? after : undefined;
    const body: UpdateOnboardingStateRequest | null =
      screen !== 'review' && (status !== undefined || cursor !== undefined)
        ? {
            ...(status === undefined ? {} : { step: { id: screen, status } }),
            ...(cursor === undefined ? {} : { currentStep: cursor }),
          }
        : null;
    if (body !== null) await save.mutateAsync(body);
    if (after !== null) setScreen(after);
  }

  if (mode === 'chooser') {
    return (
      <Chooser
        onSolo={() => {
          setMode('fast');
        }}
        onTeam={() => {
          void save.mutateAsync({ answers: { path: 'center' } }).then(() => {
            setMode('steps');
          });
        }}
        pending={save.isPending}
      />
    );
  }
  if (mode === 'fast') {
    return (
      <Card>
        <CardContent className="pt-4 sm:pt-5">
          <FastPathForm
            onBack={() => {
              setMode('chooser');
            }}
            onDone={() => {
              setMode('fast-done');
            }}
          />
        </CardContent>
      </Card>
    );
  }
  if (mode === 'fast-done') {
    return (
      <Card>
        <CardContent className="pt-4 sm:pt-5">
          <FastPathDone />
        </CardContent>
      </Card>
    );
  }

  const Screen = SCREENS[screen] ?? ReviewStep;
  const before = screenBefore(screens, screen);
  const stepCount = screens.length - 1;
  const isReview = screen === 'review';
  const optional =
    !isReview && state.wizard.steps.find((step) => step.id === screen)?.required === false;

  return (
    <div className="grid gap-5">
      <StepNav state={state} screens={screens} current={screen} onSelect={setScreen} />
      <Card>
        <CardHeader>
          {isReview ? null : (
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('progress.current', { current: index + 1, total: stepCount })}
            </p>
          )}
          <CardTitle>{t(`step.${screen}`)}</CardTitle>
          {optional ? null : isReview ? null : (
            <CardDescription>{t('progress.required')}</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <Screen
            key={screen}
            state={state}
            next={leave}
            skip={optional ? () => leave('skipped') : undefined}
            back={
              before === null
                ? undefined
                : () => {
                    setScreen(before);
                  }
            }
            goTo={setScreen}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function Chooser({
  onSolo,
  onTeam,
  pending,
}: {
  onSolo: () => void;
  onTeam: () => void;
  pending: boolean;
}) {
  const { t } = useTranslation('onboarding');
  return (
    <section aria-labelledby="chooser-title" className="grid gap-4">
      <h2 id="chooser-title" className="font-display text-lg font-semibold">
        {t('chooser.title')}
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="flex flex-col">
          <CardHeader>
            <Rocket className="size-6 text-primary-ink" aria-hidden="true" />
            <CardTitle as="h3">{t('chooser.solo.title')}</CardTitle>
            <CardDescription>{t('chooser.solo.description')}</CardDescription>
          </CardHeader>
          <CardContent className="mt-auto">
            <Button className="w-full" onClick={onSolo}>
              {t('chooser.solo.action')}
            </Button>
          </CardContent>
        </Card>
        <Card className="flex flex-col">
          <CardHeader>
            <Workflow className="size-6 text-primary-ink" aria-hidden="true" />
            <CardTitle as="h3">{t('chooser.team.title')}</CardTitle>
            <CardDescription>{t('chooser.team.description')}</CardDescription>
          </CardHeader>
          <CardContent className="mt-auto">
            <Button className="w-full" variant="outline" loading={pending} onClick={onTeam}>
              {t('chooser.team.action')}
            </Button>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
