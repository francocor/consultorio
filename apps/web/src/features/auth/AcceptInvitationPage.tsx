import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useBoot } from '../../app/boot.js';
import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { isApiError } from '../../shared/lib/api-client.js';
import { describeError } from '../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';

import { authApi } from './api/auth-api.js';
import { NewPasswordForm } from './components/NewPasswordForm.js';
import { useTokenParam } from './use-token-param.js';

/** Accepts a staff invitation (`/accept-invitation?token=`): the invitee chooses a password. */
export function AcceptInvitationPage() {
  const { t } = useTranslation(['auth', 'common']);
  usePageTitle(t('auth:accept.title'));
  const api = useApi();
  const boot = useBoot();
  const token = useTokenParam();
  const accept = useMutation({
    mutationFn: (password: string) => authApi(api).acceptInvitation(token ?? '', password),
  });

  if (!token) {
    return (
      <div className="grid gap-4">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {t('auth:accept.title')}
        </h1>
        <Alert tone="warning">
          <AlertDescription>{t('auth:accept.missingToken')}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (accept.isSuccess) {
    return (
      <div className="grid gap-4 text-center">
        <span className="mx-auto grid size-12 place-content-center rounded-full bg-success-soft text-success-soft-foreground">
          <CircleCheck className="size-6" aria-hidden="true" />
        </span>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {t('auth:accept.success.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('auth:accept.success.description')}</p>
        <Link
          to="/login"
          className="touch-target-md inline-flex items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {t('auth:accept.goToLogin')}
        </Link>
      </div>
    );
  }

  const failure = accept.isError ? accept.error : null;
  const message =
    isApiError(failure) && failure.fieldErrors.length === 0
      ? failure.code === 'bad_request'
        ? t('auth:accept.error.token')
        : failure.code === 'conflict'
          ? t('auth:accept.error.member')
          : describeError(t, failure).message
      : null;

  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {t('auth:accept.title')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('auth:accept.description', { organization: boot?.name ?? t('common:app.name') })}
        </p>
      </div>
      {message ? (
        <Alert tone="danger">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <NewPasswordForm
        passwordLabel={t('auth:field.password')}
        submitLabel={t('auth:accept.submit')}
        pending={accept.isPending}
        onSubmit={async (password) => {
          await accept.mutateAsync(password);
        }}
      />
    </div>
  );
}
