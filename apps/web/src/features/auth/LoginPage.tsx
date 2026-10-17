import { LoginRequest } from '@consultorio/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Link, useRouter, type RouterHistory } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useBoot } from '../../app/boot.js';
import { useApi, useServices } from '../../app/providers.js';
import { SESSION_QUERY_KEY } from '../../app/services.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { isApiError } from '../../shared/lib/api-client.js';
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
import { PasswordInput } from './components/PasswordInput.js';
import { useLoginSearch } from './use-login-search.js';

type Step = { kind: 'credentials' } | { kind: 'code'; challenge: string; recovery: boolean };

/** Sign in: password first, then the second factor for the accounts that have one. */
export function LoginPage() {
  const { t } = useTranslation('auth');
  usePageTitle(t('login.title'));
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const { expired } = useLoginSearch();

  return step.kind === 'credentials' ? (
    <CredentialsStep
      expired={expired}
      onChallenge={(challenge) => {
        setStep({ kind: 'code', challenge, recovery: false });
      }}
    />
  ) : (
    <CodeStep
      challenge={step.challenge}
      recovery={step.recovery}
      onToggleRecovery={() => {
        setStep({ ...step, recovery: !step.recovery });
      }}
      onBack={() => {
        setStep({ kind: 'credentials' });
      }}
    />
  );
}

/** Where to go once the session exists: the page that was asked for, or the start page. */
function useFinishSignIn() {
  const router = useRouter();
  const { queryClient } = useServices();
  const { redirect } = useLoginSearch();
  return (next: 'authenticated' | 'enrollment') => {
    // The profile of the previous visitor, if any, is not this person's.
    queryClient.removeQueries({ queryKey: SESSION_QUERY_KEY });
    const history = router.history as RouterHistory;
    history.push(next === 'enrollment' ? '/account/security' : (redirect ?? '/'));
  };
}

function CredentialsStep({
  expired,
  onChallenge,
}: {
  expired: boolean;
  onChallenge: (challenge: string) => void;
}) {
  const { t } = useTranslation(['auth', 'common']);
  const boot = useBoot();
  const api = useApi();
  const finish = useFinishSignIn();
  const form = useForm<LoginRequest>({
    resolver: zodResolver(LoginRequest),
    defaultValues: { email: '', password: '' },
  });
  const { setFocus: focusCredentials } = form;
  useEffect(() => {
    focusCredentials('email');
  }, [focusCredentials]);

  const signIn = useMutation({
    mutationFn: (values: LoginRequest) => authApi(api).login(values),
    onSuccess: (result) => {
      if (result.next === 'totp') onChallenge(result.challenge);
      else finish(result.next);
    },
    onError: () => {
      form.resetField('password');
      form.setFocus('password');
    },
  });

  const rateLimited = isApiError(signIn.error) && signIn.error.code === 'rate_limited';

  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {t('auth:login.title')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('auth:login.subtitle', { organization: boot?.name ?? t('common:app.name') })}
        </p>
      </div>

      {expired ? (
        <Alert tone="info">
          <AlertDescription>{t('auth:login.expired')}</AlertDescription>
        </Alert>
      ) : null}

      {signIn.isError ? (
        <Alert tone="danger">
          <AlertDescription>
            {rateLimited ? t('auth:login.error.rateLimited') : t('auth:login.error.invalid')}
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
          <Button type="submit" loading={signIn.isPending} className="w-full">
            {t('auth:login.submit')}
          </Button>
        </form>
      </Form>

      <div className="grid gap-3 text-center text-sm">
        <Link
          to="/forgot-password"
          className="font-medium text-primary-ink underline-offset-4 hover:underline"
        >
          {t('auth:login.forgot')}
        </Link>
        <p className="text-muted-foreground">{t('auth:login.footer')}</p>
      </div>
    </div>
  );
}

const CodeForm = z.object({ code: z.string().trim().min(1) });
type CodeForm = z.infer<typeof CodeForm>;

function CodeStep({
  challenge,
  recovery,
  onToggleRecovery,
  onBack,
}: {
  challenge: string;
  recovery: boolean;
  onToggleRecovery: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation('auth');
  const api = useApi();
  const finish = useFinishSignIn();
  const form = useForm<CodeForm>({
    resolver: zodResolver(CodeForm),
    defaultValues: { code: '' },
  });
  const { setFocus: focusCode } = form;
  useEffect(() => {
    focusCode('code');
  }, [focusCode, recovery]);

  const verify = useMutation({
    mutationFn: ({ code }: CodeForm) =>
      authApi(api).verifyTwoFactor(
        recovery ? { challenge, recoveryCode: code } : { challenge, code },
      ),
    onSuccess: (result) => {
      if (result.next !== 'totp') finish(result.next);
    },
    onError: () => {
      form.reset({ code: '' });
      form.setFocus('code');
    },
  });

  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {t('twoFactor.title')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {recovery ? t('twoFactor.recovery.description') : t('twoFactor.description')}
        </p>
      </div>

      {verify.isError ? (
        <Alert tone="danger">
          <AlertDescription>{t('twoFactor.error')}</AlertDescription>
        </Alert>
      ) : null}

      <Form {...form}>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            void form.handleSubmit((values) => {
              verify.mutate(values);
            })(event);
          }}
        >
          <FormField
            control={form.control}
            name="code"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {recovery ? t('twoFactor.recovery.code') : t('twoFactor.code')}
                </FormLabel>
                <FormControl>
                  <Input
                    inputMode={recovery ? 'text' : 'numeric'}
                    autoComplete="one-time-code"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" loading={verify.isPending} className="w-full">
            {t('twoFactor.submit')}
          </Button>
        </form>
      </Form>

      <div className="grid gap-1 text-center text-sm">
        <Button variant="link" onClick={onToggleRecovery} className="justify-self-center">
          {recovery ? t('twoFactor.useApp') : t('twoFactor.useRecovery')}
        </Button>
        <Button variant="link" onClick={onBack} className="justify-self-center">
          {t('twoFactor.back')}
        </Button>
      </div>
    </div>
  );
}
