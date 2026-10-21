import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useRouter, useSearch } from '@tanstack/react-router';
import { MailCheck, ShieldCheck } from 'lucide-react';
import { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { useBoot } from '../../../app/boot.js';
import { useApi, useServices } from '../../../app/providers.js';
import { SESSION_QUERY_KEY } from '../../../app/services.js';
import { usePageTitle } from '../../../app/use-page-title.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { applyApiFieldErrors, fieldErrorCount } from '../../../shared/lib/form-errors.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { Checkbox } from '../../../shared/ui/checkbox.js';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../../shared/ui/form.js';
import { useBotChallenge } from '../../public-booking/index.js';

import { signupApi } from './api/signup-api.js';
import { PasswordField, PasswordHints } from './components/PasswordField.js';

/** The password and the two acceptances, as the owner fills them. The server has the last word. */
const Schema = z.object({
  password: z.string().min(1).max(1024),
  acceptTerms: z.boolean().refine((accepted) => accepted, { message: 'signup.terms.required' }),
  acceptDataProcessing: z
    .boolean()
    .refine((accepted) => accepted, { message: 'signup.terms.required' }),
});
type Values = z.infer<typeof Schema>;

/** The single-use token of the emailed link (`?token=`), or undefined when it is missing. */
function useTokenParam(): string | undefined {
  const search: unknown = useSearch({ strict: false });
  const token =
    typeof search === 'object' && search !== null && 'token' in search ? search.token : undefined;
  return typeof token === 'string' && token !== '' ? token : undefined;
}

/**
 * The page the emailed link opens (`/signup/verify?token=`), on the host of the organization the
 * link activates. Opening it only SHOWS what the link is for: a mail scanner or a link preview that
 * follows the address must not spend the link, so the owner fills the form and presses the button.
 * Here the person who owns the address chooses the password and accepts the terms: the public form
 * asked for neither, because whoever typed the address there had not proved it was theirs
 * (JD-S6 R1-S6-3). The activation signs the owner in and takes them to the setup wizard. A link that
 * does not work (it expired, was used or was replaced by a newer one) offers a new one.
 */
export function VerifyPage() {
  const { t } = useTranslation(['signup', 'common']);
  usePageTitle(t('signup:verify.title'));
  const api = signupApi(useApi());
  const boot = useBoot();
  const router = useRouter();
  const { queryClient } = useServices();
  const token = useTokenParam();
  const challenge = useBotChallenge(() => api.challenge());
  const form = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { password: '', acceptTerms: false, acceptDataProcessing: false },
  });
  const password = useWatch({ control: form.control, name: 'password' });

  const verify = useMutation({
    mutationFn: (values: Values & { token: string }) => api.verify(values),
    onSuccess: () => {
      // The cookie is set. Whoever was signed in before this link is not this person.
      queryClient.removeQueries({ queryKey: SESSION_QUERY_KEY });
      void router.navigate({ to: '/onboarding' });
    },
    onError: (error) => {
      if (applyApiFieldErrors(form, error)) form.setFocus('password');
    },
  });
  const renew = useMutation({
    mutationFn: async () => api.renew(await challenge.take()),
  });

  // Only the answer "this link does not work" means that; a failure of the server or of the network
  // says nothing about the link, which was not spent, and the owner can press the button again.
  const linkInvalid =
    verify.isError && isApiError(verify.error) && verify.error.code === 'signup_link_invalid';
  const { warm } = challenge;
  useEffect(() => {
    // The puzzle for a new link is solved before the visitor asks for it.
    if (linkInvalid) warm();
  }, [linkInvalid, warm]);

  if (token === undefined) {
    return (
      <div className="mx-auto grid w-full max-w-md gap-4">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {t('signup:verify.title')}
        </h1>
        <Alert tone="warning">
          <AlertDescription>{t('signup:verify.missing')}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (renew.isSuccess) {
    return (
      <div className="mx-auto grid w-full max-w-md gap-4 text-center" aria-live="polite">
        <span className="mx-auto grid size-12 place-content-center rounded-full bg-primary-soft text-primary-ink">
          <MailCheck className="size-6" aria-hidden="true" />
        </span>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {t('signup:verify.renewed.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('signup:verify.renewed.description')}</p>
      </div>
    );
  }

  if (linkInvalid) {
    return (
      <div className="mx-auto grid w-full max-w-md gap-4">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {t('signup:verify.invalid.title')}
        </h1>
        <Alert tone="danger">
          <AlertDescription>{t('signup:verify.invalid.description')}</AlertDescription>
        </Alert>
        {renew.isError ? (
          <Alert tone="danger">
            <AlertDescription>{describeError(t, renew.error).message}</AlertDescription>
          </Alert>
        ) : null}
        <Button
          type="button"
          loading={renew.isPending}
          onClick={() => {
            renew.mutate();
          }}
        >
          {t('signup:verify.renew')}
        </Button>
      </div>
    );
  }

  // A refusal that belongs to a field is shown under it; anything else is said above the form.
  const failure = verify.isError && fieldErrorCount(verify.error) === 0 ? verify.error : null;

  return (
    <div className="mx-auto grid w-full max-w-md gap-6">
      <div className="grid gap-1.5">
        <span className="mb-2 grid size-12 place-content-center rounded-full bg-primary-soft text-primary-ink">
          <ShieldCheck className="size-6" aria-hidden="true" />
        </span>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {t('signup:verify.title')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('signup:verify.description', { organization: boot?.name ?? t('common:app.name') })}
        </p>
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
              verify.mutate({ ...values, token });
            })(event);
          }}
        >
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('signup:field.password')}</FormLabel>
                <FormControl>
                  <PasswordField autoComplete="new-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <PasswordHints value={password} />
          <fieldset className="grid gap-3">
            <legend className="sr-only">{t('signup:terms.legend')}</legend>
            <AcceptanceField form={form} name="acceptTerms" label={t('signup:terms.accept')} />
            <AcceptanceField
              form={form}
              name="acceptDataProcessing"
              label={t('signup:terms.dataProcessing')}
            />
          </fieldset>
          <Button type="submit" loading={verify.isPending} className="w-full">
            {t('signup:verify.submit')}
          </Button>
        </form>
      </Form>
    </div>
  );
}

/** One of the two acceptances: a checkbox with its sentence, and the reason when it is missing. */
function AcceptanceField({
  form,
  name,
  label,
}: {
  form: ReturnType<typeof useForm<Values>>;
  name: 'acceptTerms' | 'acceptDataProcessing';
  label: string;
}) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <div className="flex items-start gap-3">
            <FormControl>
              <Checkbox
                checked={field.value}
                onCheckedChange={(checked) => {
                  field.onChange(checked === true);
                }}
                onBlur={field.onBlur}
                name={field.name}
                ref={field.ref}
              />
            </FormControl>
            <FormLabel className="text-sm font-normal leading-snug">{label}</FormLabel>
          </div>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
