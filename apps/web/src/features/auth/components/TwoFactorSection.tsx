import type { MeResponse } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { SESSION_QUERY_KEY } from '../../../app/services.js';
import { isApiError } from '../../../shared/lib/api-client.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../shared/ui/card.js';
import { Input } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { toast } from '../../../shared/ui/toaster.js';
import { authApi } from '../api/auth-api.js';

import { PasswordConfirmDialog } from './PasswordConfirmDialog.js';
import { QrCode } from './QrCode.js';
import { RecoveryCodes } from './RecoveryCodes.js';

type Dialog = 'replace' | 'disable' | 'regenerate' | null;
interface Setup {
  secret: string;
  otpauthUri: string;
}

/** Status of the second factor and everything to change it: enroll, replace, codes, disable. */
export function TwoFactorSection({ me }: { me: MeResponse }) {
  const { t } = useTranslation(['auth', 'common']);
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { enrolled, required } = me.twoFactor;
  // The session is upgraded as soon as the factor is confirmed, so remember how it started.
  const [wasEnrollmentOnly] = useState(() => me.scope === 'two_factor_enrollment');

  const [dialog, setDialog] = useState<Dialog>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  const refreshProfile = () => queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });

  const start = useMutation({
    mutationFn: (password?: string) => authApi(api).enrollStart(password),
    onSuccess: (result) => {
      setSetup(result);
    },
  });

  async function finishCodes() {
    setCodes(null);
    await refreshProfile();
    if (wasEnrollmentOnly) await router.navigate({ to: '/' });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{t('auth:security.twoFactor.title')}</CardTitle>
          <div className="flex gap-2">
            {required ? <Badge tone="info">{t('auth:security.twoFactor.required')}</Badge> : null}
            {enrolled ? (
              <Badge tone="success">
                <ShieldCheck aria-hidden="true" />
                {t('auth:security.twoFactor.on')}
              </Badge>
            ) : (
              <Badge tone="warning">
                <ShieldOff aria-hidden="true" />
                {t('auth:security.twoFactor.off')}
              </Badge>
            )}
          </div>
        </div>
        <CardDescription>{t('auth:security.twoFactor.intro')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {codes ? (
          <RecoveryCodes codes={codes} onDone={() => void finishCodes()} />
        ) : setup ? (
          <EnrollmentStep
            setup={setup}
            onCancel={() => {
              setSetup(null);
            }}
            onConfirmed={(recoveryCodes) => {
              setSetup(null);
              setCodes(recoveryCodes);
              void refreshProfile();
            }}
          />
        ) : (
          <>
            {enrolled && required ? (
              <p className="text-sm text-muted-foreground">
                {t('auth:security.twoFactor.mandatory')}
              </p>
            ) : null}
            {start.isError && !dialog ? (
              <Alert tone="danger">
                <AlertDescription>{describeError(t, start.error).message}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {enrolled ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setDialog('replace');
                    }}
                  >
                    {t('auth:security.twoFactor.replace')}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setDialog('regenerate');
                    }}
                  >
                    {t('auth:security.recovery.regenerate')}
                  </Button>
                  {required ? null : (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setDialog('disable');
                      }}
                    >
                      {t('auth:security.twoFactor.disable')}
                    </Button>
                  )}
                </>
              ) : (
                <Button
                  loading={start.isPending}
                  onClick={() => {
                    start.mutate(undefined);
                  }}
                >
                  {t('auth:security.twoFactor.enroll')}
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>

      <PasswordConfirmDialog
        open={dialog === 'replace'}
        onOpenChange={(open) => {
          setDialog(open ? 'replace' : null);
        }}
        title={t('auth:security.twoFactor.password')}
        description={t('auth:security.twoFactor.passwordHelp')}
        confirmLabel={t('auth:security.twoFactor.continue')}
        onConfirm={async (password) => {
          setSetup(await start.mutateAsync(password));
        }}
      />
      <PasswordConfirmDialog
        open={dialog === 'regenerate'}
        onOpenChange={(open) => {
          setDialog(open ? 'regenerate' : null);
        }}
        title={t('auth:security.recovery.regenerate')}
        description={t('auth:security.recovery.regenerateHelp')}
        confirmLabel={t('auth:security.twoFactor.continue')}
        onConfirm={async (password) => {
          const result = await authApi(api).regenerateRecoveryCodes(password);
          setCodes(result.recoveryCodes);
        }}
      />
      <PasswordConfirmDialog
        open={dialog === 'disable'}
        onOpenChange={(open) => {
          setDialog(open ? 'disable' : null);
        }}
        title={t('auth:security.twoFactor.disableTitle')}
        description={t('auth:security.twoFactor.passwordHelp')}
        confirmLabel={t('auth:security.twoFactor.disableConfirm')}
        destructive
        onConfirm={async (password) => {
          await authApi(api).disableTwoFactor(password);
          await refreshProfile();
          toast.success(t('auth:security.twoFactor.disabled'));
        }}
      />
    </Card>
  );
}

function EnrollmentStep({
  setup,
  onCancel,
  onConfirmed,
}: {
  setup: Setup;
  onCancel: () => void;
  onConfirmed: (codes: readonly string[]) => void;
}) {
  const { t } = useTranslation(['auth', 'common']);
  const api = useApi();
  const form = useForm<{ code: string }>({ defaultValues: { code: '' } });
  const { setFocus } = form;
  useEffect(() => {
    setFocus('code');
  }, [setFocus]);
  const confirm = useMutation({
    mutationFn: ({ code }: { code: string }) => authApi(api).enrollConfirm(code),
    onSuccess: (result) => {
      onConfirmed(result.recoveryCodes);
    },
    onError: () => {
      form.reset({ code: '' });
      form.setFocus('code');
    },
  });
  const wrongCode = isApiError(confirm.error) && confirm.error.status === 400;

  return (
    <div className="grid gap-5">
      <div className="grid gap-3">
        <p className="text-sm">{t('auth:security.twoFactor.scan')}</p>
        <QrCode value={setup.otpauthUri} alt={t('auth:security.twoFactor.qrAlt')} />
        <p className="text-sm text-muted-foreground">{t('auth:security.twoFactor.manualKey')}</p>
        <code className="tabular w-fit select-all break-all rounded-md bg-muted px-3 py-2 font-mono text-sm tracking-wider">
          {setup.secret}
        </code>
      </div>

      <form
        className="grid max-w-sm gap-3"
        noValidate
        onSubmit={(event) => {
          void form.handleSubmit((values) => {
            confirm.mutate(values);
          })(event);
        }}
      >
        <p className="text-sm">{t('auth:security.twoFactor.enter')}</p>
        {confirm.isError ? (
          <Alert tone="danger">
            <AlertDescription>
              {wrongCode
                ? t('auth:security.twoFactor.confirmError')
                : describeError(t, confirm.error).message}
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-1.5">
          <Label htmlFor="enroll-code">{t('auth:twoFactor.code')}</Label>
          <Input
            id="enroll-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            {...form.register('code', { required: true })}
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" loading={confirm.isPending}>
            {t('auth:security.twoFactor.confirm')}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            {t('auth:security.twoFactor.cancel')}
          </Button>
        </div>
      </form>
    </div>
  );
}
