import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { MailCheck } from 'lucide-react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { describeError } from '../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Button } from '../../shared/ui/button.js';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../shared/ui/form.js';
import { Input } from '../../shared/ui/input.js';

import { authApi } from './api/auth-api.js';

const Schema = z.object({ email: z.string().trim().pipe(z.email().max(254)) });
type Values = z.infer<typeof Schema>;

/** Asks for a reset link. The answer is the same whether or not the account exists. */
export function ForgotPasswordPage() {
  const { t } = useTranslation(['auth', 'common']);
  usePageTitle(t('auth:forgot.title'));
  const api = useApi();
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: { email: '' } });
  const { setFocus } = form;
  useEffect(() => {
    setFocus('email');
  }, [setFocus]);
  const request = useMutation({
    mutationFn: (values: Values) => authApi(api).requestReset(values.email),
  });

  if (request.isSuccess) {
    return (
      <div className="grid gap-4 text-center">
        <span className="mx-auto grid size-12 place-content-center rounded-full bg-primary-soft text-primary-ink">
          <MailCheck className="size-6" aria-hidden="true" />
        </span>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {t('auth:forgot.done.title')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('auth:forgot.done.description', { email: form.getValues('email') })}
        </p>
        <Link
          to="/login"
          className="link-target text-sm font-medium text-primary-ink underline-offset-4 hover:underline"
        >
          {t('auth:forgot.back')}
        </Link>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {t('auth:forgot.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('auth:forgot.description')}</p>
      </div>
      {request.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, request.error).message}</AlertDescription>
        </Alert>
      ) : null}
      <Form {...form}>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            void form.handleSubmit((values) => {
              request.mutate(values);
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
          <Button type="submit" loading={request.isPending} className="w-full">
            {t('auth:forgot.submit')}
          </Button>
        </form>
      </Form>
      <Link
        to="/login"
        className="link-target text-center text-sm font-medium text-primary-ink underline-offset-4 hover:underline"
      >
        {t('auth:forgot.back')}
      </Link>
    </div>
  );
}
