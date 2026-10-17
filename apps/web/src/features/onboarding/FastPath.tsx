import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CalendarDays, CheckCircle2, UserPlus } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useApi } from '../../app/providers.js';
import { applyApiFieldErrors, fieldErrorCount } from '../../shared/lib/form-errors.js';
import { describeError } from '../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Button } from '../../shared/ui/button.js';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../shared/ui/form.js';
import { Input } from '../../shared/ui/input.js';
import { staffKeys } from '../staff/api/staff-api.js';
import { MatriculaFields, requireMatricula } from '../staff/components/MatriculaFields.js';

import { onboardingApi, onboardingKeys } from './api/onboarding-api.js';
import { splitSpecialties } from './specialties.js';

const Schema = z
  .object({
    fullName: z.string().trim().max(120),
    specialty: z.string().trim().max(400),
    jurisdiction: z.string(),
    matriculaNumber: z.string().trim().max(32),
    locationName: z.string().trim().max(120),
  })
  .superRefine((values, ctx) => {
    if (values.fullName === '') {
      ctx.addIssue({ code: 'custom', path: ['fullName'], message: 'validation.required' });
    }
    if (splitSpecialties(values.specialty).length === 0) {
      ctx.addIssue({ code: 'custom', path: ['specialty'], message: 'validation.required' });
    }
    // Decision D21 (revised): attending needs a complete professional profile, matricula included.
    requireMatricula(values, ctx);
  });
type Values = z.infer<typeof Schema>;

/**
 * The solo fast path: who attends (name, specialty and matricula, the complete professional
 * profile of decision D21), and everything else is set up with sensible defaults.
 */
export function FastPathForm({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const { t } = useTranslation(['onboarding', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const form = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: {
      fullName: '',
      specialty: '',
      jurisdiction: '',
      matriculaNumber: '',
      locationName: '',
    },
  });

  const run = useMutation({
    mutationFn: (values: Values) =>
      onboardingApi(api).fastPath({
        fullName: values.fullName,
        specialties: splitSpecialties(values.specialty),
        matricula: { jurisdiction: values.jurisdiction, number: values.matriculaNumber },
        ...(values.locationName === '' ? {} : { locationName: values.locationName }),
      }),
    onSuccess: async (result) => {
      queryClient.setQueryData(onboardingKeys.state, result.state);
      await queryClient.invalidateQueries({ queryKey: staffKeys.all });
      onDone();
    },
    onError: (error) => {
      applyApiFieldErrors(form, error, { specialties: 'specialty', matricula: 'matriculaNumber' });
    },
  });
  const generalFailure = run.isError && fieldErrorCount(run.error) === 0;

  return (
    <Form {...form}>
      <form
        noValidate
        className="grid gap-5"
        onSubmit={(event) => {
          void form.handleSubmit((values) => {
            run.mutate(values);
          })(event);
        }}
      >
        <div className="grid gap-1">
          <h2 className="font-display text-lg font-semibold">{t('onboarding:fast.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('onboarding:fast.description')}</p>
        </div>
        {generalFailure ? (
          <Alert tone="danger">
            <AlertDescription>{describeError(t, run.error).message}</AlertDescription>
          </Alert>
        ) : null}
        <FormField
          control={form.control}
          name="fullName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('onboarding:fast.fullName')}</FormLabel>
              <FormControl>
                <Input autoComplete="name" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="specialty"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('onboarding:fast.specialty')}</FormLabel>
              <FormControl>
                <Input autoComplete="off" {...field} />
              </FormControl>
              <FormDescription>{t('onboarding:fast.specialty.hint')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <MatriculaFields />
        <FormField
          control={form.control}
          name="locationName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('onboarding:fast.locationName')}</FormLabel>
              <FormControl>
                <Input autoComplete="organization" {...field} />
              </FormControl>
              <FormDescription>{t('onboarding:fast.locationName.hint')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Button variant="outline" onClick={onBack}>
            {t('onboarding:fast.back')}
          </Button>
          <Button type="submit" loading={run.isPending}>
            {t('onboarding:fast.submit')}
          </Button>
        </div>
      </form>
    </Form>
  );
}

/**
 * The end of the fast path: what was left ready, and the two things to do next, which are the two
 * ends of the first booking (register a patient, open the agenda).
 */
export function FastPathDone() {
  const { t } = useTranslation('onboarding');
  return (
    <section aria-labelledby="fast-done-title" className="grid gap-5">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-1 size-6 shrink-0 text-success" aria-hidden="true" />
        <div className="grid gap-1">
          <h2 id="fast-done-title" className="font-display text-lg font-semibold">
            {t('done.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('done.description')}</p>
        </div>
      </div>
      <p className="text-sm">{t('done.defaults')}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button asChild>
          <Link to="/calendar">
            <CalendarDays aria-hidden="true" />
            {t('done.calendar')}
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/patients/new">
            <UserPlus aria-hidden="true" />
            {t('done.patient')}
          </Link>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{t('done.later')}</p>
    </section>
  );
}
