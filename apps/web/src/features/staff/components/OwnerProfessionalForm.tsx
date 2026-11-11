import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useApi } from '../../../app/providers.js';
import { SESSION_QUERY_KEY } from '../../../app/services.js';
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
import { Input } from '../../../shared/ui/input.js';
import { toast } from '../../../shared/ui/toaster.js';
import { splitSpecialties } from '../../onboarding/specialties.js';
import { staffApi, staffKeys } from '../api/staff-api.js';

import { MatriculaFields, requireMatricula } from './MatriculaFields.js';

const Schema = z
  .object({
    fullName: z.string().trim().max(120),
    specialty: z.string().trim().max(400),
    jurisdiction: z.string(),
    matriculaNumber: z.string().trim().max(32),
  })
  .superRefine((values, ctx) => {
    if (values.fullName === '') {
      ctx.addIssue({ code: 'custom', path: ['fullName'], message: 'validation.required' });
    }
    if (splitSpecialties(values.specialty).length === 0) {
      ctx.addIssue({ code: 'custom', path: ['specialty'], message: 'validation.required' });
    }
    requireMatricula(values, ctx);
  });
type Values = z.infer<typeof Schema>;

/**
 * An owner who attends patients (decision D21, revised 2026-10-17). The owner may do it at any
 * time, provided the professional profile is complete: name, specialty, and the matricula with its
 * jurisdiction. Saving it grants the professional role next to the owner role, in one step.
 */
export function OwnerProfessionalForm({ defaultName }: { defaultName: string }) {
  const { t } = useTranslation(['staff', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const form = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { fullName: defaultName, specialty: '', jurisdiction: '', matriculaNumber: '' },
  });

  const activate = useMutation({
    mutationFn: (values: Values) =>
      staffApi(api).becomeProfessional({
        fullName: values.fullName,
        specialties: splitSpecialties(values.specialty),
        matricula: { jurisdiction: values.jurisdiction, number: values.matriculaNumber },
      }),
    onSuccess: async () => {
      toast.success(t('staff:ownerProfessional.done'));
      // The roles changed: the navigation and the permissions come from the session.
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: staffKeys.all });
    },
    onError: (error) => {
      applyApiFieldErrors(form, error, { matricula: 'matriculaNumber', specialties: 'specialty' });
    },
  });
  const generalFailure = activate.isError && fieldErrorCount(activate.error) === 0;

  return (
    <Form {...form}>
      <form
        noValidate
        className="grid gap-5"
        onSubmit={(event) => {
          void form.handleSubmit((values) => {
            activate.mutate(values);
          })(event);
        }}
      >
        <div className="grid gap-1">
          <h3 className="font-display text-base font-semibold">
            {t('staff:ownerProfessional.title')}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t('staff:ownerProfessional.description')}
          </p>
        </div>

        {generalFailure ? (
          <Alert tone="danger">
            <AlertDescription>{describeError(t, activate.error).message}</AlertDescription>
          </Alert>
        ) : null}

        <FormField
          control={form.control}
          name="fullName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('staff:profile.fullName')}</FormLabel>
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
              <FormLabel>{t('staff:ownerProfessional.specialty')}</FormLabel>
              <FormControl>
                <Input autoComplete="off" {...field} />
              </FormControl>
              <FormDescription>{t('staff:ownerProfessional.specialtyHelp')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <MatriculaFields />

        <Button type="submit" loading={activate.isPending} className="justify-self-start">
          {t('staff:ownerProfessional.submit')}
        </Button>
      </form>
    </Form>
  );
}
