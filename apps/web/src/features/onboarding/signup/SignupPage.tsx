import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { MailCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
import { Input } from '../../../shared/ui/input.js';
import { useBotChallenge } from '../../public-booking/index.js';

import { signupApi } from './api/signup-api.js';
import { usePlatformTitle } from './use-platform-title.js';

/** Line breaks, control and format characters, and the Unicode line separators: a name has none. */
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const plainName = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !HIDDEN_CHARACTER.test(value), { message: 'signup.name.invalid' });

/** The form as the visitor fills it. The server has the last word on every rule it knows. */
const Schema = z.object({
  organizationName: plainName(2, 80),
  ownerName: plainName(2, 100),
  email: z.string().trim().pipe(z.email().max(254)),
});
type Values = z.infer<typeof Schema>;

/**
 * The public signup (`/signup`, platform host). A visitor gives the name of the organization, their
 * own name and an email; the page never says whether the name or the address already existed (the
 * answer is always "check your email"), and the address of the organization is made by the platform,
 * not chosen here. There is no password and no acceptance of the terms on this page: whoever types
 * an address here has not proved it is theirs, so the owner chooses the password and accepts the
 * terms on the page of the emailed link (`VerifyPage`).
 */
export function SignupPage() {
  const { t } = useTranslation(['signup', 'common']);
  usePlatformTitle(t('signup:page.title'));
  const api = signupApi(useApi());
  const challenge = useBotChallenge(() => api.challenge());
  const [sentTo, setSentTo] = useState<string | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { organizationName: '', ownerName: '', email: '' },
  });
  const { setFocus } = form;
  const { warm } = challenge;
  useEffect(() => {
    setFocus('organizationName');
    // The puzzle is solved while the visitor types, so the send does not wait for it.
    warm();
  }, [setFocus, warm]);

  const signUp = useMutation({
    mutationFn: async (values: Values) =>
      api.signUp({ ...values, challengeProof: await challenge.take() }),
    onSuccess: (_answer, values) => {
      setSentTo(values.email.trim());
    },
    onError: (error) => {
      if (applyApiFieldErrors(form, error)) form.setFocus('organizationName');
    },
  });

  if (sentTo !== null) {
    return (
      <CheckYourEmail
        email={sentTo}
        onChangeEmail={() => {
          setSentTo(null);
        }}
      />
    );
  }

  const failure = signUp.isError && fieldErrorCount(signUp.error) === 0 ? signUp.error : null;

  return (
    <div className="mx-auto grid w-full max-w-md gap-6 rounded-xl border bg-card p-6 shadow-sm sm:p-8">
      <div className="grid gap-1.5">
        <h1 className="font-display text-2xl font-semibold tracking-tight">{t('signup:title')}</h1>
        <p className="text-sm text-muted-foreground">{t('signup:description')}</p>
      </div>
      {failure ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, failure).message}</AlertDescription>
        </Alert>
      ) : null}
      <Form {...form}>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            void form.handleSubmit((values) => {
              signUp.mutate(values);
            })(event);
          }}
        >
          <FormField
            control={form.control}
            name="organizationName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('signup:field.organization')}</FormLabel>
                <FormControl>
                  <Input autoComplete="organization" maxLength={80} {...field} />
                </FormControl>
                <FormDescription>{t('signup:field.organization.hint')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="ownerName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('signup:field.owner')}</FormLabel>
                <FormControl>
                  <Input autoComplete="name" maxLength={100} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('signup:field.email')}</FormLabel>
                <FormControl>
                  <Input type="email" autoComplete="email" inputMode="email" {...field} />
                </FormControl>
                <FormDescription>{t('signup:field.email.hint')}</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" loading={signUp.isPending} className="w-full">
            {t('signup:submit')}
          </Button>
        </form>
      </Form>
      <p className="text-center text-sm text-muted-foreground">{t('signup:login.hint')}</p>
    </div>
  );
}

/**
 * What the visitor sees after sending the form, whatever happened behind it: the same words for a
 * new address, one with an account and one that was waiting. They can ask for another message.
 */
function CheckYourEmail({ email, onChangeEmail }: { email: string; onChangeEmail: () => void }) {
  const { t } = useTranslation(['signup', 'common']);
  const api = signupApi(useApi());
  const challenge = useBotChallenge(() => api.challenge());
  const heading = useRef<HTMLHeadingElement>(null);
  const { warm } = challenge;
  useEffect(() => {
    heading.current?.focus();
    warm();
  }, [warm]);
  const resend = useMutation({
    mutationFn: async () => api.resend(email, await challenge.take()),
  });

  return (
    <div
      className="mx-auto grid w-full max-w-md gap-4 rounded-xl border bg-card p-6 text-center shadow-sm sm:p-8"
      aria-live="polite"
    >
      <span className="mx-auto grid size-12 place-content-center rounded-full bg-primary-soft text-primary-ink">
        <MailCheck className="size-6" aria-hidden="true" />
      </span>
      <h1
        ref={heading}
        tabIndex={-1}
        className="font-display text-2xl font-semibold tracking-tight outline-none"
      >
        {t('signup:sent.title')}
      </h1>
      <p className="text-sm text-muted-foreground">{t('signup:sent.description', { email })}</p>
      <p className="text-sm text-muted-foreground">{t('signup:sent.spam')}</p>
      {resend.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, resend.error).message}</AlertDescription>
        </Alert>
      ) : null}
      {resend.isSuccess ? (
        <Alert tone="success">
          <AlertDescription>{t('signup:sent.resent')}</AlertDescription>
        </Alert>
      ) : null}
      <Button
        type="button"
        variant="outline"
        loading={resend.isPending}
        onClick={() => {
          resend.mutate();
        }}
      >
        {t('signup:sent.resend')}
      </Button>
      <Button type="button" variant="ghost" onClick={onChangeEmail}>
        {t('signup:sent.change')}
      </Button>
    </div>
  );
}
