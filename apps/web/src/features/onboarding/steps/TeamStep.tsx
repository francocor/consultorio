import { rolesInviterMayGrant, type StaffRole } from '@consultorio/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useApi } from '../../../app/providers.js';
import { useMe } from '../../../app/session.js';
import { applyApiFieldErrors, fieldErrorCount } from '../../../shared/lib/form-errors.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription, AlertTitle } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../../shared/ui/form.js';
import { Input, Select } from '../../../shared/ui/input.js';
import { toast } from '../../../shared/ui/toaster.js';
import { staffApi, staffKeys } from '../../staff/api/staff-api.js';
import { onboardingApi, onboardingKeys } from '../api/onboarding-api.js';
import { StepFooter } from '../components/StepFooter.js';

import type { StepProps } from './types.js';

/** The roles this step offers, in the order a small practice needs them. */
const ROLE_ORDER: readonly StaffRole[] = ['reception', 'admin', 'professional'];

const Schema = z.object({
  email: z.string().trim().min(1, 'validation.required').pipe(z.email('validation.email')),
  role: z.enum(['reception', 'admin', 'professional']),
});
type Values = z.infer<typeof Schema>;

interface Sent {
  email: string;
  role: StaffRole;
}

/**
 * Invitations from the first run. The ceiling is the inviter's: an owner can invite anyone, an
 * admin with the grant only reception and admins. Before an invitation goes out the server says
 * whether it changes the plan; until subscriptions exist it never does, and when it does the
 * person confirms first.
 */
export function TeamStep({ next, skip, back }: StepProps) {
  const { t } = useTranslation(['onboarding', 'common']);
  const api = useApi();
  const me = useMe();
  const queryClient = useQueryClient();
  const [sent, setSent] = useState<Sent[]>([]);
  const [pending, setPending] = useState<Values | null>(null);

  const offered = ROLE_ORDER.filter((role) => rolesInviterMayGrant(me.roles).includes(role));
  const form = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { email: '', role: offered[0] === 'admin' ? 'admin' : 'reception' },
  });

  const send = useMutation({
    mutationFn: (values: Values) =>
      staffApi(api).invite({ email: values.email, roles: [values.role] }),
    onSuccess: async (_result, values) => {
      toast.success(t('onboarding:team.sent'));
      setSent((previous) => [...previous, { email: values.email, role: values.role }]);
      setPending(null);
      form.reset({ email: '', role: values.role });
      await queryClient.invalidateQueries({ queryKey: staffKeys.all });
      await queryClient.invalidateQueries({ queryKey: onboardingKeys.state });
    },
    onError: (error) => {
      applyApiFieldErrors(form, error, { email: 'email' });
    },
  });

  // Asks what the invitation does to the plan, then sends it or waits for a confirmation.
  const check = useMutation({
    mutationFn: async (values: Values) => {
      const impact = await onboardingApi(api).invitationImpact([values.role]);
      if (impact.affectsPlan) {
        setPending(values);
        return;
      }
      await send.mutateAsync(values);
    },
  });

  const failure = (send.isError ? send.error : null) ?? (check.isError ? check.error : null);

  return (
    <div className="grid gap-5">
      <p className="text-sm text-muted-foreground">{t('onboarding:team.description')}</p>

      <Form {...form}>
        <form
          noValidate
          className="grid gap-4 rounded-md border p-4"
          onSubmit={(event) => {
            void form.handleSubmit((values) => {
              setPending(null);
              check.mutate(values);
            })(event);
          }}
        >
          {failure !== null && fieldErrorCount(failure) === 0 ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, failure).message}</AlertDescription>
            </Alert>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('onboarding:team.email')}</FormLabel>
                  <FormControl>
                    <Input type="email" inputMode="email" autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('onboarding:team.role')}</FormLabel>
                  <FormControl>
                    <Select {...field}>
                      {offered.map((role) => (
                        <option key={role} value={role}>
                          {t(`onboarding:team.role.${role}`)}
                        </option>
                      ))}
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          {offered.includes('professional') ? null : (
            <p className="text-sm text-muted-foreground">{t('onboarding:team.professionalNote')}</p>
          )}

          {pending ? (
            <Alert tone="warning">
              <AlertTitle>{t('onboarding:team.impact.title')}</AlertTitle>
              <AlertDescription className="grid gap-2">
                <span>{t('onboarding:team.impact.description')}</span>
                <Button
                  className="w-fit"
                  loading={send.isPending}
                  onClick={() => {
                    send.mutate(pending);
                  }}
                >
                  {t('onboarding:team.impact.confirm')}
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <Button type="submit" variant="outline" loading={check.isPending} className="w-fit">
              {t('onboarding:team.send')}
            </Button>
          )}
        </form>
      </Form>

      {sent.length > 0 ? (
        <ul aria-label={t('onboarding:team.sentList')} className="grid gap-2">
          {sent.map((item) => (
            <li key={`${item.email}-${item.role}`} className="rounded-md border p-3 text-sm">
              {item.email} · {t(`onboarding:team.role.${item.role}`)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t('onboarding:team.optional')}</p>
      )}

      <StepFooter
        onBack={back}
        onSkip={
          skip
            ? () => {
                void skip();
              }
            : undefined
        }
        continueDisabled={sent.length === 0}
        onContinue={() => {
          void next('done');
        }}
      />
    </div>
  );
}
