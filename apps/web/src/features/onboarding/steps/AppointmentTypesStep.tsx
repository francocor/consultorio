import {
  AppointmentTypeDto,
  AppointmentTypeListResponse,
  type CreateAppointmentTypeRequest,
} from '@consultorio/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useApi } from '../../../app/providers.js';
import { applyApiFieldErrors, fieldErrorCount } from '../../../shared/lib/form-errors.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../../shared/ui/form.js';
import { Input, Select } from '../../../shared/ui/input.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { onboardingKeys } from '../api/onboarding-api.js';
import { StepFooter } from '../components/StepFooter.js';

import type { StepProps } from './types.js';

const TYPES_KEY = ['appointment-types'] as const;
const DURATIONS = [15, 20, 30, 45, 60, 90] as const;

const Schema = z.object({
  name: z.string().trim().min(1, 'validation.required').max(80),
  durationMinutes: z.coerce.number().int().min(1).max(1440),
});
type Values = z.input<typeof Schema>;
type Parsed = z.output<typeof Schema>;

/** What can be booked. One type is enough to start; the full list is edited later. */
export function AppointmentTypesStep({ next, back }: StepProps) {
  const { t } = useTranslation(['onboarding', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const types = useQuery({
    queryKey: TYPES_KEY,
    queryFn: async (): Promise<AppointmentTypeDto[]> =>
      (await api.get('/appointment-types', { schema: AppointmentTypeListResponse })).types,
  });
  const form = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(Schema),
    defaultValues: { name: '', durationMinutes: 30 },
  });

  const create = useMutation({
    mutationFn: (values: Parsed) => {
      const body: Pick<CreateAppointmentTypeRequest, 'name' | 'durationMinutes' | 'mode'> = {
        name: values.name,
        durationMinutes: values.durationMinutes,
        mode: 'in_person',
      };
      return api.post('/appointment-types', { body, schema: AppointmentTypeDto });
    },
    onSuccess: async () => {
      toast.success(t('onboarding:types.added'));
      form.reset({ name: '', durationMinutes: 30 });
      await queryClient.invalidateQueries({ queryKey: TYPES_KEY });
      await queryClient.invalidateQueries({ queryKey: onboardingKeys.state });
    },
    onError: (error) => {
      applyApiFieldErrors(form, error);
    },
  });

  if (types.isPending) return <FormSkeleton fields={2} />;
  if (types.isError) {
    return (
      <ErrorState
        error={types.error}
        onRetry={() => {
          void types.refetch();
        }}
      />
    );
  }

  const active = types.data.filter((type) => type.active);
  const generalFailure = create.isError && fieldErrorCount(create.error) === 0;

  return (
    <div className="grid gap-5">
      <p className="text-sm text-muted-foreground">{t('onboarding:types.description')}</p>

      {active.length > 0 ? (
        <ul aria-label={t('onboarding:types.existing')} className="grid gap-2">
          {active.map((type) => (
            <li
              key={type.id}
              className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"
            >
              <span className="font-medium">{type.name}</span>
              <span className="text-muted-foreground">
                {t('onboarding:types.minutes', { minutes: type.durationMinutes })}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm font-medium">{t('onboarding:types.needOne')}</p>
      )}

      <Form {...form}>
        <form
          noValidate
          className="grid gap-4 rounded-md border p-4"
          onSubmit={(event) => {
            void form.handleSubmit((values) => {
              create.mutate(values);
            })(event);
          }}
        >
          {generalFailure ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, create.error).message}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('onboarding:types.name')}</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormDescription>{t('onboarding:types.name.hint')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="durationMinutes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('onboarding:types.duration')}</FormLabel>
                  <FormControl>
                    <Select {...field} value={String(field.value)}>
                      {DURATIONS.map((minutes) => (
                        <option key={minutes} value={minutes}>
                          {t('onboarding:types.duration.option', { minutes })}
                        </option>
                      ))}
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <Button type="submit" variant="outline" loading={create.isPending} className="w-fit">
            {t('onboarding:types.add')}
          </Button>
        </form>
      </Form>

      <StepFooter
        onBack={back}
        continueDisabled={active.length === 0}
        onContinue={() => {
          void next();
        }}
      />
    </div>
  );
}
