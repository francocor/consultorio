import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { isApiError } from '../../shared/lib/api-client.js';
import { describeError } from '../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';

import { authApi } from './api/auth-api.js';
import { NewPasswordForm } from './components/NewPasswordForm.js';
import { useTokenParam } from './use-token-param.js';

/** Sets a new password from the emailed link (`/reset-password?token=`). */
export function ResetPasswordPage() {
  const { t } = useTranslation(['auth', 'common']);
  usePageTitle(t('auth:reset.title'));
  const api = useApi();
  const token = useTokenParam();
  const reset = useMutation({
    mutationFn: (password: string) => authApi(api).completeReset(token ?? '', password),
  });

  if (!token) {
    return (
      <div className="grid gap-4">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {t('auth:reset.title')}
        </h1>
        <Alert tone="warning">
          <AlertDescription>{t('auth:reset.missingToken')}</AlertDescription>
        </Alert>
        <Link
          to="/forgot-password"
          className="text-sm font-medium text-primary-ink underline-offset-4 hover:underline"
        >
          {t('auth:reset.requestNew')}
        </Link>
      </div>
    );
  }

  if (reset.isSuccess) {
    return (
      <div className="grid gap-4 text-center">
        <span className="mx-auto grid size-12 place-content-center rounded-full bg-success-soft text-success-soft-foreground">
          <CircleCheck className="size-6" aria-hidden="true" />
        </span>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {t('auth:reset.success.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('auth:reset.success.description')}</p>
        <Link
          to="/login"
          className="touch-target-md inline-flex items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {t('auth:login.title')}
        </Link>
      </div>
    );
  }

  // A rejected token is not a field problem: the link itself is no good.
  const failure = reset.isError ? reset.error : null;
  const tokenProblem = isApiError(failure) && failure.fieldErrors.length === 0;

  return (
    <div className="grid gap-6">
      <div className="grid gap-1.5">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {t('auth:reset.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('auth:reset.description')}</p>
      </div>
      {tokenProblem ? (
        <>
          <Alert tone="danger">
            <AlertDescription>
              {failure.code === 'bad_request'
                ? t('auth:reset.error.token')
                : describeError(t, failure).message}
            </AlertDescription>
          </Alert>
          <Link
            to="/forgot-password"
            className="text-sm font-medium text-primary-ink underline-offset-4 hover:underline"
          >
            {t('auth:reset.requestNew')}
          </Link>
        </>
      ) : null}
      <NewPasswordForm
        passwordLabel={t('auth:reset.new')}
        submitLabel={t('auth:reset.submit')}
        pending={reset.isPending}
        onSubmit={async (password) => {
          await reset.mutateAsync(password);
        }}
      />
    </div>
  );
}
