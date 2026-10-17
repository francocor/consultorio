import type { WeeklyInterval } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, UsersRound } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { useMe } from '../../../app/session.js';
import { locationsApi, LOCATIONS_QUERY_KEY } from '../../../shared/api/locations-api.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { Checkbox } from '../../../shared/ui/checkbox.js';
import { Input, Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { staffApi, staffKeys } from '../../staff/api/staff-api.js';
import { toMinutes } from '../../staff/domain/hours.js';
import { onboardingKeys } from '../api/onboarding-api.js';
import { StepFooter } from '../components/StepFooter.js';
import { summarizeWeek } from '../schedule-summary.js';

import type { StepProps } from './types.js';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const DEFAULT_DAYS = [1, 2, 3, 4, 5];
const DEFAULT_START = '09:00';
const DEFAULT_END = '17:00';

type Problem = 'no_days' | 'end_before_start';

/** Working days and one interval for them, for the professional at a place. */
export function HoursStep({ next, back, goTo }: StepProps) {
  const { t } = useTranslation(['onboarding', 'staff', 'common']);
  const api = useApi();
  const me = useMe();
  const team = useQuery({
    queryKey: staffKeys.list(false),
    queryFn: () => staffApi(api).list(false),
  });
  const places = useQuery({
    queryKey: [...LOCATIONS_QUERY_KEY, { showInactive: false }],
    queryFn: () => locationsApi(api).list(false),
  });

  if (team.isPending || places.isPending) return <FormSkeleton fields={3} />;
  if (team.isError || places.isError) {
    return (
      <ErrorState
        error={team.error ?? places.error}
        onRetry={() => {
          void team.refetch();
          void places.refetch();
        }}
      />
    );
  }

  const professionals = team.data.filter((member) => member.professional?.status === 'active');
  if (professionals.length === 0) {
    return (
      <div className="grid gap-5">
        <EmptyState
          icon={UsersRound}
          title={t('onboarding:hours.empty.title')}
          description={t('onboarding:hours.empty.description')}
          action={
            <Button
              onClick={() => {
                goTo('team');
              }}
            >
              {t('onboarding:hours.empty.action')}
            </Button>
          }
        />
        <StepFooter onBack={back} continueDisabled onContinue={() => undefined} />
      </div>
    );
  }
  if (places.data.length === 0) {
    return (
      <div className="grid gap-5">
        <Alert tone="warning">
          <AlertDescription>{t('onboarding:hours.needsLocation')}</AlertDescription>
        </Alert>
        <StepFooter onBack={back} continueDisabled onContinue={() => undefined} />
      </div>
    );
  }

  const own = professionals.find((member) => member.email === me.user.email);
  return (
    <HoursForm
      professionals={professionals.map((member) => ({
        id: member.professional?.id ?? '',
        name: member.displayName ?? member.email ?? '',
      }))}
      initialProfessionalId={(own ?? professionals[0])?.professional?.id ?? ''}
      places={places.data}
      next={next}
      back={back}
    />
  );
}

function HoursForm({
  professionals,
  initialProfessionalId,
  places,
  next,
  back,
}: {
  professionals: { id: string; name: string }[];
  initialProfessionalId: string;
  places: { id: string; name: string }[];
  next: StepProps['next'];
  back: StepProps['back'];
}) {
  const { t } = useTranslation(['onboarding', 'staff', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [professionalId, setProfessionalId] = useState(initialProfessionalId);
  const [locationId, setLocationId] = useState(places[0]?.id ?? '');
  const [days, setDays] = useState<number[]>(DEFAULT_DAYS);
  const [start, setStart] = useState(DEFAULT_START);
  const [end, setEnd] = useState(DEFAULT_END);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [editing, setEditing] = useState(false);

  const current = useQuery({
    queryKey: staffKeys.hours(professionalId),
    queryFn: () => staffApi(api).hours(professionalId),
    enabled: professionalId !== '',
  });
  const nameOf = (weekday: number) => t(`staff:weekday.${String(weekday)}`);
  const existing = current.data?.hours ?? [];
  const summary = summarizeWeek(existing, nameOf);
  const showForm = existing.length === 0 || editing;

  const save = useMutation({
    mutationFn: () => {
      const hours: WeeklyInterval[] = days
        .toSorted((a, b) => a - b)
        .map((weekday) => ({ locationId, weekday, start, end }));
      return staffApi(api).setHours(professionalId, hours);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: staffKeys.all });
      await queryClient.invalidateQueries({ queryKey: onboardingKeys.state });
      await next();
    },
  });

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (days.length === 0) {
      setProblem('no_days');
      return;
    }
    const from = toMinutes(start);
    const to = toMinutes(end);
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) {
      setProblem('end_before_start');
      return;
    }
    setProblem(null);
    save.mutate();
  }

  function toggle(weekday: number, checked: boolean) {
    setDays((previous) =>
      checked ? [...new Set([...previous, weekday])] : previous.filter((day) => day !== weekday),
    );
  }

  if (current.isError) {
    return (
      <ErrorState
        error={current.error}
        onRetry={() => {
          void current.refetch();
        }}
      />
    );
  }

  const professionalPicker =
    professionals.length > 1 ? (
      <div className="grid gap-1.5">
        <Label htmlFor="hours-professional">{t('onboarding:hours.professional')}</Label>
        <Select
          id="hours-professional"
          value={professionalId}
          onChange={(event) => {
            setProfessionalId(event.target.value);
            setEditing(false);
          }}
        >
          {professionals.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </Select>
      </div>
    ) : null;

  if (current.isPending) return <FormSkeleton fields={3} />;

  if (!showForm) {
    return (
      <div className="grid gap-5">
        <p className="text-sm text-muted-foreground">{t('onboarding:hours.description')}</p>
        {professionalPicker}
        <div className="flex items-start gap-3 rounded-md border p-4">
          <CalendarClock
            className="mt-0.5 size-5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="grid gap-2">
            <p className="text-sm font-medium">
              {summary ? t('onboarding:hours.current', { summary }) : t('onboarding:hours.custom')}
            </p>
            {summary ? (
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => {
                  setEditing(true);
                }}
              >
                {t('onboarding:hours.edit')}
              </Button>
            ) : null}
          </div>
        </div>
        <StepFooter
          onBack={back}
          onContinue={() => {
            void next();
          }}
        />
      </div>
    );
  }

  return (
    <form noValidate className="grid gap-5" onSubmit={submit}>
      <p className="text-sm text-muted-foreground">{t('onboarding:hours.description')}</p>
      {save.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, save.error).message}</AlertDescription>
        </Alert>
      ) : null}
      {professionalPicker}
      {places.length > 1 ? (
        <div className="grid gap-1.5">
          <Label htmlFor="hours-location">{t('onboarding:hours.location')}</Label>
          <Select
            id="hours-location"
            value={locationId}
            onChange={(event) => {
              setLocationId(event.target.value);
            }}
          >
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      <fieldset
        className="grid gap-2"
        aria-describedby={problem === 'no_days' ? 'hours-days-error' : undefined}
      >
        <legend className="mb-1 text-sm font-medium">{t('onboarding:hours.days')}</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {WEEKDAYS.map((weekday) => {
            const id = `hours-day-${String(weekday)}`;
            const checked = days.includes(weekday);
            return (
              <div
                key={weekday}
                className="flex items-center gap-2 rounded-md border p-2 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary-soft"
              >
                <Checkbox
                  id={id}
                  checked={checked}
                  onCheckedChange={(value) => {
                    toggle(weekday, value === true);
                  }}
                />
                <Label htmlFor={id} className="flex-1 cursor-pointer font-normal">
                  {nameOf(weekday)}
                </Label>
              </div>
            );
          })}
        </div>
        {problem === 'no_days' ? (
          <p id="hours-days-error" className="text-sm font-medium text-destructive">
            {t('onboarding:hours.noDays')}
          </p>
        ) : null}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="hours-start">{t('onboarding:hours.from')}</Label>
          <Input
            id="hours-start"
            type="time"
            value={start}
            onChange={(event) => {
              setStart(event.target.value);
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="hours-end">{t('onboarding:hours.to')}</Label>
          <Input
            id="hours-end"
            type="time"
            value={end}
            aria-invalid={problem === 'end_before_start' || undefined}
            aria-describedby={problem === 'end_before_start' ? 'hours-end-error' : undefined}
            onChange={(event) => {
              setEnd(event.target.value);
            }}
          />
          {problem === 'end_before_start' ? (
            <p id="hours-end-error" className="text-sm font-medium text-destructive">
              {t('onboarding:hours.endBeforeStart')}
            </p>
          ) : null}
        </div>
      </div>

      <StepFooter onBack={back} pending={save.isPending} />
    </form>
  );
}
