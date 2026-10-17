import type { ProfessionalStepRequest } from '@consultorio/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useApi } from '../../../app/providers.js';
import { useMe } from '../../../app/session.js';
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
import { RadioCard, RadioGroup } from '../../../shared/ui/radio-card.js';
import { staffApi, staffKeys } from '../../staff/api/staff-api.js';
import { MatriculaFields, requireMatricula } from '../../staff/components/MatriculaFields.js';
import { onboardingApi, onboardingKeys } from '../api/onboarding-api.js';
import { StepFooter } from '../components/StepFooter.js';
import { splitSpecialties } from '../specialties.js';

import type { StepProps } from './types.js';

const Schema = z
  .object({
    isProfessional: z.enum(['', 'yes', 'no']),
    fullName: z.string().trim().max(120),
    specialty: z.string().trim().max(400),
    jurisdiction: z.string(),
    matriculaNumber: z.string().trim().max(32),
  })
  .superRefine((values, ctx) => {
    if (values.isProfessional !== 'yes') return;
    if (values.fullName === '') {
      ctx.addIssue({ code: 'custom', path: ['fullName'], message: 'validation.required' });
    }
    if (splitSpecialties(values.specialty).length === 0) {
      ctx.addIssue({ code: 'custom', path: ['specialty'], message: 'validation.required' });
    }
    // Decision D21 (revised): the owner is a professional only with a complete profile.
    requireMatricula(values, ctx);
  });
type Values = z.infer<typeof Schema>;

/**
 * "Are you a health professional?" (tenant-onboarding, "Tenant defaults and initial roles"). Yes
 * gives the owner a professional profile next to the owner role, which needs the name, a specialty
 * and the matricula with its jurisdiction (decision D21); no keeps them without clinical access
 * and sends them to invite a professional.
 */
export function ProfileStep({ state, next, back }: StepProps) {
  const { t } = useTranslation(['onboarding', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const me = useMe();

  // The owner's own profile, if there is one: the form opens with it instead of blank.
  const team = useQuery({
    queryKey: staffKeys.list(false),
    queryFn: () => staffApi(api).list(false),
  });
  const own = team.data?.find((member) => member.email === me.user.email);
  const ownProfile = own?.professional;
  const answered = state.wizard.answers.isProfessional;

  const form = useForm<Values>({
    resolver: zodResolver(Schema),
    values: {
      isProfessional: answered === undefined ? '' : answered ? 'yes' : 'no',
      fullName: own?.displayName ?? '',
      specialty: ownProfile?.specialties.join(', ') ?? '',
      jurisdiction: ownProfile?.matricula?.jurisdiction ?? '',
      matriculaNumber: ownProfile?.matricula?.number ?? '',
    },
  });
  const choice = useWatch({ control: form.control, name: 'isProfessional' });

  const save = useMutation({
    mutationFn: (values: Values) => {
      const body: ProfessionalStepRequest =
        values.isProfessional === 'yes'
          ? {
              isProfessional: true,
              fullName: values.fullName,
              specialties: splitSpecialties(values.specialty),
              matricula: { jurisdiction: values.jurisdiction, number: values.matriculaNumber },
            }
          : { isProfessional: false };
      return onboardingApi(api).professional(body);
    },
    onSuccess: async (updated) => {
      queryClient.setQueryData(onboardingKeys.state, updated);
      await queryClient.invalidateQueries({ queryKey: staffKeys.all });
      await next();
    },
    onError: (error) => {
      applyApiFieldErrors(form, error, { matricula: 'matriculaNumber', specialties: 'specialty' });
    },
  });

  const generalFailure = save.isError && fieldErrorCount(save.error) === 0;

  return (
    <Form {...form}>
      <form
        noValidate
        className="grid gap-5"
        onSubmit={(event) => {
          void form.handleSubmit((values) => {
            save.mutate(values);
          })(event);
        }}
      >
        <p className="text-sm text-muted-foreground">{t('onboarding:profile.description')}</p>

        {generalFailure ? (
          <Alert tone="danger">
            <AlertDescription>{describeError(t, save.error).message}</AlertDescription>
          </Alert>
        ) : null}

        <FormField
          control={form.control}
          name="isProfessional"
          render={({ field }) => (
            <FormItem>
              <span id="profile-question" className="text-sm font-medium">
                {t('onboarding:profile.question')}
              </span>
              <RadioGroup
                aria-labelledby="profile-question"
                value={field.value}
                onValueChange={field.onChange}
              >
                <RadioCard
                  value="yes"
                  title={t('onboarding:profile.yes.title')}
                  description={t('onboarding:profile.yes.description')}
                />
                <RadioCard
                  value="no"
                  title={t('onboarding:profile.no.title')}
                  description={t('onboarding:profile.no.description')}
                />
              </RadioGroup>
              <FormMessage />
            </FormItem>
          )}
        />

        {choice === 'no' ? (
          <Alert tone="info">
            <AlertDescription>{t('onboarding:profile.noProfessional')}</AlertDescription>
          </Alert>
        ) : null}

        {choice === 'yes' ? (
          <div className="grid gap-4">
            <FormField
              control={form.control}
              name="fullName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('onboarding:profile.fullName')}</FormLabel>
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
                  <FormLabel>{t('onboarding:profile.specialty')}</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormDescription>{t('onboarding:profile.specialty.hint')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <MatriculaFields />
          </div>
        ) : null}

        <StepFooter
          onBack={back}
          pending={save.isPending}
          continueDisabled={choice !== 'yes' && choice !== 'no'}
        />
      </form>
    </Form>
  );
}
