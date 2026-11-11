import type { OnboardingStateDto } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { ListChecks } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { Button } from '../../shared/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../shared/ui/dialog.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../shared/ui/toaster.js';

import { onboardingApi, onboardingKeys } from './api/onboarding-api.js';
import { ChecklistItems, ChecklistProgress } from './components/ChecklistItems.js';
import { useOnboardingState, useRunsOnboarding } from './use-onboarding-state.js';

/** Hides or brings back the checklist of the start page. The answer replaces the cached state. */
function useDismissal() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dismissed: boolean) =>
      onboardingApi(api).update({ checklistDismissed: dismissed }),
    onSuccess: (state) => {
      queryClient.setQueryData(onboardingKeys.state, state);
    },
  });
}

/** Every item done and the wizard finished: nothing is left to show. */
function isFinished(state: OnboardingStateDto): boolean {
  return state.wizard.completed && state.checklist.items.every((item) => item.done);
}

/**
 * The first-run checklist in the shell's slot (app-shell-ux, "Guided first run hook"): what is left
 * to set up, marked from real data, for the people who run the first run, until it is finished or
 * dismissed. It stays quiet while loading and when the progress cannot be read: a card about setup
 * must never get in the way of the page it sits above.
 */
export function FirstRunChecklist() {
  const { t } = useTranslation('onboarding');
  const runs = useRunsOnboarding();
  const state = useOnboardingState();
  const dismiss = useDismissal();
  const pathname = useRouterState({ select: (router) => router.location.pathname });

  if (!runs || !state.data) return null;
  const { checklist, wizard } = state.data;
  // The wizard screen is its own checklist.
  if (checklist.dismissed || isFinished(state.data) || pathname === '/onboarding') return null;

  return (
    <section
      aria-labelledby="first-run-title"
      className="mb-6 grid gap-4 rounded-lg border bg-card p-4 text-card-foreground sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 id="first-run-title" className="font-display text-base font-semibold">
            {t('checklist.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('checklist.description')}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          loading={dismiss.isPending}
          onClick={() => {
            dismiss.mutate(true, {
              onSuccess: () => {
                toast.success(t('checklist.dismissed'));
              },
            });
          }}
        >
          {t('checklist.dismiss')}
        </Button>
      </div>
      <ChecklistProgress items={checklist.items} />
      <details open={pathname === '/'} className="group">
        <summary className="touch-target-md flex cursor-pointer items-center text-sm font-medium text-primary-ink">
          {t('checklist.title')}
        </summary>
        <div className="pt-2">
          <ChecklistItems items={checklist.items} />
        </div>
      </details>
      {wizard.completed ? null : (
        <div>
          <Button asChild>
            <Link to="/onboarding">{t('checklist.continue')}</Link>
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * The checklist reachable from Help (the account menu), whether or not it was dismissed: the
 * current progress, a way back into the wizard and a way to bring the card back to the start page.
 */
export function ChecklistDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation('onboarding');
  const state = useOnboardingState();
  const dismissal = useDismissal();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListChecks className="size-5" aria-hidden="true" />
            {t('checklist.title')}
          </DialogTitle>
          <DialogDescription>{t('checklist.description')}</DialogDescription>
        </DialogHeader>
        {state.isPending ? (
          <ListSkeleton rows={4} />
        ) : state.isError ? (
          <ErrorState
            error={state.error}
            onRetry={() => {
              void state.refetch();
            }}
          />
        ) : (
          <div className="grid gap-4">
            <ChecklistProgress items={state.data.checklist.items} />
            <ChecklistItems
              items={state.data.checklist.items}
              onNavigate={() => {
                onOpenChange(false);
              }}
            />
          </div>
        )}
        {state.data ? (
          <DialogFooter>
            {state.data.checklist.dismissed ? (
              <Button
                variant="outline"
                loading={dismissal.isPending}
                onClick={() => {
                  dismissal.mutate(false);
                }}
              >
                {t('checklist.restore')}
              </Button>
            ) : null}
            {state.data.wizard.completed ? null : (
              <Button asChild>
                <Link
                  to="/onboarding"
                  onClick={() => {
                    onOpenChange(false);
                  }}
                >
                  {t('checklist.continue')}
                </Link>
              </Button>
            )}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
