import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { MapPin } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useApi } from '../../../app/providers.js';
import { locationsApi, LOCATIONS_QUERY_KEY } from '../../../shared/api/locations-api.js';
import { applyApiFieldErrors, fieldErrorCount } from '../../../shared/lib/form-errors.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../../shared/ui/form.js';
import { Input } from '../../../shared/ui/input.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { StepFooter } from '../components/StepFooter.js';

import type { StepProps } from './types.js';

const DEFAULT_NAME = 'Consultorio';

const Schema = z.object({ name: z.string().trim().max(120) });
type Values = z.infer<typeof Schema>;

/** The first place where the organization attends. A required step: nothing can be booked without one. */
export function LocationStep({ next, back }: StepProps) {
  const { t } = useTranslation(['onboarding', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const locations = useQuery({
    queryKey: [...LOCATIONS_QUERY_KEY, { showInactive: false }],
    queryFn: () => locationsApi(api).list(false),
  });
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: { name: '' } });

  const create = useMutation({
    mutationFn: (values: Values) =>
      locationsApi(api).create({ name: values.name === '' ? DEFAULT_NAME : values.name }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: LOCATIONS_QUERY_KEY });
      await next();
    },
    onError: (error) => {
      applyApiFieldErrors(form, error);
    },
  });

  if (locations.isPending) return <FormSkeleton fields={1} />;
  if (locations.isError) {
    return (
      <ErrorState
        error={locations.error}
        onRetry={() => {
          void locations.refetch();
        }}
      />
    );
  }

  const existing = locations.data;
  if (existing.length > 0) {
    return (
      <div className="grid gap-5">
        <p className="text-sm text-muted-foreground">{t('onboarding:location.description')}</p>
        <div className="grid gap-2">
          <p className="text-sm font-medium">{t('onboarding:location.existing')}</p>
          <ul className="grid gap-2">
            {existing.map((place) => (
              <li key={place.id} className="flex items-center gap-2 rounded-md border p-3 text-sm">
                <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                {place.name}
              </li>
            ))}
          </ul>
          <Link
            to="/settings/locations"
            className="link-target w-fit text-sm font-medium text-primary-ink underline-offset-4 hover:underline"
          >
            {t('onboarding:location.manage')}
          </Link>
        </div>
        <StepFooter
          onBack={back}
          continueLabel={t('onboarding:action.save')}
          onContinue={() => {
            void next();
          }}
        />
      </div>
    );
  }

  const generalFailure = create.isError && fieldErrorCount(create.error) === 0;
  return (
    <Form {...form}>
      <form
        noValidate
        className="grid gap-5"
        onSubmit={(event) => {
          void form.handleSubmit((values) => {
            create.mutate(values);
          })(event);
        }}
      >
        <p className="text-sm text-muted-foreground">{t('onboarding:location.description')}</p>
        {generalFailure ? (
          <Alert tone="danger">
            <AlertDescription>{describeError(t, create.error).message}</AlertDescription>
          </Alert>
        ) : null}
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('onboarding:location.name')}</FormLabel>
              <FormControl>
                <Input autoComplete="organization" placeholder={DEFAULT_NAME} {...field} />
              </FormControl>
              <FormDescription>{t('onboarding:location.name.hint')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <StepFooter onBack={back} pending={create.isPending} />
      </form>
    </Form>
  );
}
