import type { StaffMemberDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../../app/providers.js';
import { describeError } from '../../../../shared/lib/translate.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../../../shared/ui/alert-dialog.js';
import { Button } from '../../../../shared/ui/button.js';
import { Input } from '../../../../shared/ui/input.js';
import { EmptyState } from '../../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../../shared/ui/toaster.js';
import { calendarApi, calendarKeys } from '../../../calendar/api/calendar-api.js';
import { staffApi, staffKeys } from '../../../staff/api/staff-api.js';
import { needsConfirmation, parseCapacity, profileRequestFor } from '../domain/overbooking.js';

/**
 * How many appointments a professional may have at the same time. One is the default and the
 * rule of the agenda; two or more (overbooking) is a decision, so it asks before it is allowed.
 * The public booking channels keep using one regardless.
 */
export function OverbookingSection() {
  const { t } = useTranslation(['scheduling', 'common']);
  const api = useApi();
  const people = useQuery({
    queryKey: calendarKeys.professionals,
    queryFn: () => calendarApi(api).professionals(),
  });

  return (
    <section aria-labelledby="overbooking-title" className="grid gap-4">
      <div className="grid gap-1">
        <h2 id="overbooking-title" className="font-display text-lg font-semibold">
          {t('scheduling:config.overbooking.title')}
        </h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t('scheduling:config.overbooking.description')}
        </p>
      </div>

      {people.isPending ? (
        <ListSkeleton rows={3} />
      ) : people.isError ? (
        <ErrorState
          error={people.error}
          onRetry={() => {
            void people.refetch();
          }}
        />
      ) : people.data.length === 0 ? (
        <EmptyState
          icon={Layers}
          title={t('scheduling:noProfessionals.title')}
          description={t('scheduling:noProfessionals.description')}
        />
      ) : (
        <ul className="grid gap-3">
          {people.data.map((member) => (
            <CapacityRow key={member.membershipId} member={member} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CapacityRow({ member }: { member: StaffMemberDto }) {
  const { t } = useTranslation(['scheduling', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const name = member.displayName ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);

  const profile = useQuery({
    queryKey: staffKeys.profile(member.membershipId),
    queryFn: () => staffApi(api).profile(member.membershipId),
  });

  const save = useMutation({
    mutationFn: (capacity: number) => {
      if (!profile.data) throw new Error('the profile is not loaded');
      const request = profileRequestFor(profile.data, member, capacity);
      if (!request) throw new Error('the profile has no discipline');
      return staffApi(api).saveProfile(member.membershipId, request);
    },
    onSuccess: async () => {
      toast.success(t('scheduling:config.overbooking.saved', { name }));
      setDraft(null);
      setConfirming(null);
      await queryClient.invalidateQueries({ queryKey: staffKeys.all });
    },
  });

  const current = profile.data?.maxSimultaneous ?? 1;
  const text = draft ?? String(current);
  const inputId = `capacity-${member.membershipId}`;

  function submit() {
    setProblem(null);
    const capacity = parseCapacity(text);
    if (capacity === null) {
      setProblem(t('scheduling:config.overbooking.invalid'));
      return;
    }
    if (profile.data && profile.data.specialties.length === 0) {
      setProblem(t('scheduling:config.overbooking.noDiscipline'));
      return;
    }
    if (capacity === current) {
      setDraft(null);
      return;
    }
    if (needsConfirmation(current, capacity)) setConfirming(capacity);
    else save.mutate(capacity);
  }

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4">
      <div className="grid min-w-0 flex-1 basis-56 gap-1">
        <p className="font-medium">{name}</p>
        <p className="text-sm text-muted-foreground">
          {member.professional?.specialties.join(', ')}
        </p>
        {profile.isSuccess ? (
          <p className="text-sm text-muted-foreground">
            {current <= 1
              ? t('scheduling:config.overbooking.none')
              : t('scheduling:config.overbooking.upTo', { count: current })}
          </p>
        ) : null}
      </div>
      {profile.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('common:loading')}
        </p>
      ) : profile.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {describeError(t, profile.error).message}
        </p>
      ) : (
        <form
          noValidate
          className="flex flex-wrap items-start gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            id={inputId}
            type="number"
            inputMode="numeric"
            min={1}
            max={20}
            className="w-24"
            aria-label={t('scheduling:config.overbooking.inputLabel', { name })}
            aria-invalid={problem !== null}
            aria-describedby={problem ? `${inputId}-error` : undefined}
            value={text}
            onChange={(event) => {
              setDraft(event.target.value);
              setProblem(null);
            }}
          />
          <Button
            type="submit"
            variant="outline"
            aria-label={t('scheduling:config.overbooking.saveNamed', { name })}
            loading={save.isPending}
          >
            {t('common:action.save')}
          </Button>
          {problem ? (
            <p
              id={`${inputId}-error`}
              role="alert"
              className="basis-full text-sm font-medium text-destructive"
            >
              {problem}
            </p>
          ) : null}
          {save.isError ? (
            <p role="alert" className="basis-full text-sm font-medium text-destructive">
              {describeError(t, save.error).message}
            </p>
          ) : null}
        </form>
      )}

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('scheduling:config.overbooking.confirm.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('scheduling:config.overbooking.confirm.description', {
                name,
                count: confirming ?? 2,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:action.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirming !== null) save.mutate(confirming);
              }}
            >
              {t('scheduling:config.overbooking.confirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
