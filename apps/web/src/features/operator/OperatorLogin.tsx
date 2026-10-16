import type { OperatorDto } from '@consultorio/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useApi } from '../../app/providers.js';
import { isApiError } from '../../shared/lib/api-client.js';
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
import { PasswordInput } from '../auth/components/PasswordInput.js';

import { operatorApi } from './api/operator-api.js';

const Schema = z.object({
  email: z.string().trim().min(1, 'validation.required').pipe(z.email()),
  password: z.string().min(1, 'validation.required'),
  code: z.string().trim().min(1, 'validation.required'),
});
type Values = z.infer<typeof Schema>;

/** Password and second-factor code in one step: there is no half-signed-in state. */
export function OperatorLogin({ onSignedIn }: { onSignedIn: (operator: OperatorDto) => void }) {
  const { t } = useTranslation(['operator', 'auth']);
  const api = useApi();
  const form = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { email: '', password: '', code: '' },
  });
  const { setFocus } = form;
  useEffect(() => {
    setFocus('email');
  }, [setFocus]);

  const signIn = useMutation({
    mutationFn: (values: Values) => operatorApi(api).login(values),
    onSuccess: onSignedIn,
    onError: () => {
      form.resetField('password');
      form.resetField('code');
      form.setFocus('password');
    },
  });
  const rateLimited = isApiError(signIn.error) && signIn.error.code === 'rate_limited';

  return (
    <main id="main" className="grid min-h-dvh place-items-center bg-muted/40 p-4">
      <div className="grid w-full max-w-md gap-6 rounded-xl border bg-card p-6 shadow-sm sm:p-8">
        <div className="grid gap-3">
          <span
            aria-hidden="true"
            className="grid size-11 place-content-center rounded-lg bg-primary text-primary-foreground"
          >
            <ShieldCheck className="size-6" />
          </span>
          <div className="grid gap-1.5">
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              {t('operator:title')}
            </h1>
            <p className="text-sm text-muted-foreground">{t('operator:subtitle')}</p>
          </div>
        </div>

        {signIn.isError ? (
          <Alert tone="danger">
            <AlertDescription>
              {rateLimited
                ? t('operator:login.error.rateLimited')
                : t('operator:login.error.invalid')}
            </AlertDescription>
          </Alert>
        ) : null}

        <Form {...form}>
          <form
            noValidate
            className="grid gap-4"
            onSubmit={(event) => {
              void form.handleSubmit((values) => {
                signIn.mutate(values);
              })(event);
            }}
          >
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('auth:field.email')}</FormLabel>
                  <FormControl>
                    <Input type="email" inputMode="email" autoComplete="username" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('auth:field.password')}</FormLabel>
                  <FormControl>
                    <PasswordInput autoComplete="current-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('operator:login.code')}</FormLabel>
                  <FormControl>
                    <Input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={12}
                      className="tabular"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>{t('operator:login.codeHelp')}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" loading={signIn.isPending}>
              {t('operator:login.submit')}
            </Button>
          </form>
        </Form>
      </div>
    </main>
  );
}
