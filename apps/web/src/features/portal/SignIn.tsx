import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { describeError } from '../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Button } from '../../shared/ui/button.js';
import { Input } from '../../shared/ui/input.js';
import { Label } from '../../shared/ui/label.js';
import { useBotChallenge } from '../public-booking/index.js';

import { portalApi, portalKeys } from './api/portal-api.js';
import { CodeEntry } from './components/CodeEntry.js';

type Mode = 'signIn' | 'register';

/** A document number as a person types it: dots and spaces do not matter. */
const looksLikeDocument = (value: string) => /^\d{7,8}$/.test(value.replace(/[.\s]/g, ''));
const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/**
 * How a patient gets into the portal: with the email of their account (a code, no password), or, the
 * first time, with the DNI and the email they gave the consultorio. The answer to either request is
 * the same whatever the data: the page never says whether an account or a record exists, and the
 * code arrives only where it should.
 */
export function SignIn() {
  const { t } = useTranslation(['portal', 'common']);
  const api = portalApi(useApi());
  const queryClient = useQueryClient();
  const challenge = useBotChallenge();
  const emailId = useId();
  const documentId = useId();
  const [mode, setMode] = useState<Mode>('signIn');
  const [step, setStep] = useState<'form' | 'code'>('form');
  const [email, setEmail] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [problem, setProblem] = useState<'email' | 'document' | null>(null);
  const [resent, setResent] = useState(false);

  const normalizedEmail = email.trim().toLowerCase();

  const request = useMutation({
    mutationFn: async () => {
      const proof = await challenge.take();
      return mode === 'register'
        ? api.requestRegistration(nationalId.trim(), normalizedEmail, proof)
        : api.requestCode(normalizedEmail, proof);
    },
    onSuccess: () => {
      setStep('code');
    },
  });
  const resend = useMutation({
    mutationFn: async () => {
      const proof = await challenge.take();
      return mode === 'register'
        ? api.requestRegistration(nationalId.trim(), normalizedEmail, proof)
        : api.requestCode(normalizedEmail, proof);
    },
    onSuccess: () => {
      setResent(true);
    },
  });
  const confirm = useMutation({
    mutationFn: (code: string) =>
      mode === 'register'
        ? api.verifyRegistration(nationalId.trim(), normalizedEmail, code)
        : api.verifyCode(normalizedEmail, code),
    onSuccess: async () => {
      // The cookie is set: ask who is in.
      await queryClient.invalidateQueries({ queryKey: portalKeys.all });
    },
  });

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (mode === 'register' && !looksLikeDocument(nationalId)) {
      setProblem('document');
      return;
    }
    if (!looksLikeEmail(email)) {
      setProblem('email');
      return;
    }
    setProblem(null);
    request.mutate();
  }

  function switchTo(next: Mode) {
    setMode(next);
    setProblem(null);
    request.reset();
  }

  if (step === 'code') {
    return (
      <CodeEntry
        purpose={mode}
        onConfirm={async (code) => {
          await confirm.mutateAsync(code).catch(() => undefined);
        }}
        onResend={async () => {
          setResent(false);
          await resend.mutateAsync().catch(() => undefined);
        }}
        onChangeData={() => {
          setStep('form');
          setResent(false);
          confirm.reset();
          resend.reset();
        }}
        confirming={confirm.isPending}
        resending={resend.isPending}
        error={confirm.error ?? resend.error}
        resent={resent}
      />
    );
  }

  const failure = request.error ? describeError(t, request.error) : null;
  return (
    <section aria-labelledby="portal-signin-title" className="grid gap-5">
      <div className="grid gap-1">
        <h1 id="portal-signin-title" className="font-display text-2xl font-semibold tracking-tight">
          {t(mode === 'register' ? 'portal:register.title' : 'portal:signIn.title')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t(mode === 'register' ? 'portal:register.description' : 'portal:signIn.description')}
        </p>
      </div>

      {failure ? (
        <Alert tone="danger">
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      ) : null}

      <form
        noValidate
        className="grid gap-4"
        onSubmit={submit}
        onFocus={() => {
          challenge.warm();
        }}
      >
        {mode === 'register' ? (
          <div className="grid gap-1.5">
            <Label htmlFor={documentId}>{t('portal:register.nationalId')}</Label>
            <Input
              id={documentId}
              inputMode="numeric"
              autoComplete="off"
              aria-invalid={problem === 'document'}
              value={nationalId}
              onChange={(event) => {
                setNationalId(event.target.value);
                setProblem(null);
              }}
            />
            {problem === 'document' ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {t('portal:register.nationalIdInvalid')}
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="grid gap-1.5">
          <Label htmlFor={emailId}>
            {t(mode === 'register' ? 'portal:register.email' : 'portal:signIn.email')}
          </Label>
          <Input
            id={emailId}
            type="email"
            inputMode="email"
            autoComplete="email"
            aria-invalid={problem === 'email'}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setProblem(null);
            }}
          />
          {problem === 'email' ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {t('portal:signIn.emailInvalid')}
            </p>
          ) : null}
        </div>
        <Button type="submit" size="lg" loading={request.isPending}>
          {t('portal:signIn.submit')}
        </Button>
      </form>

      <p className="text-sm text-muted-foreground">
        {t(mode === 'register' ? 'portal:register.switchPrompt' : 'portal:signIn.switchPrompt')}{' '}
        <Button
          variant="link"
          className="inline h-auto p-0 align-baseline"
          onClick={() => {
            switchTo(mode === 'register' ? 'signIn' : 'register');
          }}
        >
          {t(mode === 'register' ? 'portal:register.switchAction' : 'portal:signIn.switchAction')}
        </Button>
      </p>
    </section>
  );
}
