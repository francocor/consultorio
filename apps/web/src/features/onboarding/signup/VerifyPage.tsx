import { useMutation } from '@tanstack/react-query';
import { useRouter, useSearch } from '@tanstack/react-router';
import { MailCheck, ShieldCheck } from 'lucide-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useBoot } from '../../../app/boot.js';
import { useApi, useServices } from '../../../app/providers.js';
import { SESSION_QUERY_KEY } from '../../../app/services.js';
import { usePageTitle } from '../../../app/use-page-title.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { useBotChallenge } from '../../public-booking/index.js';

import { signupApi } from './api/signup-api.js';

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
 * follows the address must not spend the link, so the visitor presses the button. The activation
 * signs the owner in and takes them to the setup wizard. A link that does not work (it expired, was
 * used or was replaced by a newer one) offers a new one.
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

  const verify = useMutation({
    mutationFn: (value: string) => api.verify(value),
    onSuccess: () => {
      // The cookie is set. Whoever was signed in before this link is not this person.
      queryClient.removeQueries({ queryKey: SESSION_QUERY_KEY });
      void router.navigate({ to: '/onboarding' });
    },
  });
  const renew = useMutation({
    mutationFn: async () => api.renew(await challenge.take()),
  });

  // Only the answer "this link does not work" means that; a failure of the server or of the network
  // says nothing about the link, which was not spent, and the visitor can press the button again.
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
      {verify.isError ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, verify.error).message}</AlertDescription>
        </Alert>
      ) : null}
      <Button
        type="button"
        loading={verify.isPending}
        onClick={() => {
          verify.mutate(token);
        }}
      >
        {t('signup:verify.submit')}
      </Button>
    </div>
  );
}
