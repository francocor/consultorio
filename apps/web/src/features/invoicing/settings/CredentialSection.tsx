import type { CredentialSummaryDto } from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatDate } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { Input } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { StatusBadge, type Status } from '../../../shared/ui/states/status-badge.js';
import { toast } from '../../../shared/ui/toaster.js';
import { invoicingApi, invoicingKeys } from '../api/invoicing-api.js';

import { isFieldFailure, serverFieldMessage } from './field-errors.js';

const BADGE: Record<CredentialSummaryDto['state'], Status> = {
  valid: 'ok',
  expiring: 'warning',
  expired: 'error',
  invalid: 'error',
};

interface Chosen {
  name: string;
  text: string;
}

/** Reads a chosen file as text. The text goes to the server and nowhere else: it is never shown. */
function readText(file: File): Promise<Chosen> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({ name: file.name, text: typeof reader.result === 'string' ? reader.result : '' });
    };
    reader.onerror = () => {
      reject(new Error('unreadable file'));
    };
    reader.readAsText(file);
  });
}

/**
 * The certificate and key for the tax authority. What is shown about a stored certificate is its
 * state, its expiry and a short fingerprint; the certificate and the key are never returned by the
 * server and never displayed. The upload sends the two files as text and forgets them.
 */
export function CredentialSection({
  credential,
  hasProfile,
  simulated,
}: {
  credential: CredentialSummaryDto | null;
  hasProfile: boolean;
  simulated: boolean;
}) {
  const { t } = useTranslation('invoicing');
  const api = useApi();
  const queryClient = useQueryClient();
  const [certificate, setCertificate] = useState<Chosen | null>(null);
  const [privateKey, setPrivateKey] = useState<Chosen | null>(null);
  const [attempted, setAttempted] = useState(false);
  // Changing the key remounts the file inputs, which is the only way to empty them.
  const [round, setRound] = useState(0);

  const upload = useMutation({
    mutationFn: (body: { certificate: string; privateKey: string }) =>
      invoicingApi(api).uploadCredential(body),
    onSuccess: async () => {
      toast.success(t('credential.uploaded'));
      setCertificate(null);
      setPrivateKey(null);
      setAttempted(false);
      setRound((value) => value + 1);
      await queryClient.invalidateQueries({ queryKey: invoicingKeys.config });
    },
  });

  const choose =
    (set: (chosen: Chosen | null) => void) => (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        set(null);
        return;
      }
      void readText(file).then(set, () => {
        set(null);
      });
    };

  const submit = () => {
    setAttempted(true);
    if (certificate && privateKey) {
      upload.mutate({ certificate: certificate.text, privateKey: privateKey.text });
    }
  };

  const certificateError = serverFieldMessage(upload.error, 'certificate', t);
  const keyError = serverFieldMessage(upload.error, 'privateKey', t);
  const missingFiles = attempted && (!certificate || !privateKey);
  const expires = credential ? formatDate(credential.notAfter) : '';

  return (
    <section
      aria-labelledby="credential-title"
      className="grid gap-3 rounded-lg border bg-card p-4"
    >
      <div className="grid gap-0.5">
        <h3 id="credential-title" className="font-medium">
          {t('credential.title')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('credential.description')}</p>
      </div>

      {credential ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={BADGE[credential.state]}>
              {t(`credential.state.${credential.state}`)}
            </StatusBadge>
            <span className="tabular text-sm">{t('credential.expires', { date: expires })}</span>
          </div>
          <p className="tabular text-xs text-muted-foreground">
            {t('credential.cuit', { cuit: credential.subjectCuit })}
          </p>
          <p className="tabular text-xs text-muted-foreground">
            {t('credential.fingerprint', {
              fingerprint: `${credential.fingerprint.slice(0, 16)}…`,
            })}
          </p>
          {credential.state === 'expiring' ? (
            <Alert tone="warning">
              <AlertDescription>
                {t('credential.expiringWarning', { date: expires })}
              </AlertDescription>
            </Alert>
          ) : null}
          {credential.state === 'expired' ? (
            <Alert tone="danger">
              <AlertDescription>{t('credential.expiredWarning')}</AlertDescription>
            </Alert>
          ) : null}
          {credential.state === 'invalid' ? (
            <Alert tone="danger">
              <AlertDescription>{t('credential.invalidWarning')}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('credential.none')}</p>
      )}

      {hasProfile ? (
        <form
          className="grid gap-3 sm:max-w-xl"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {upload.isError && !isFieldFailure(upload.error) ? (
            <Alert tone="danger">
              <AlertDescription>{describeError(t, upload.error).message}</AlertDescription>
            </Alert>
          ) : null}

          <FileField
            key={`certificate-${String(round)}`}
            id="credential-certificate"
            label={t('credential.certificate')}
            accept=".crt,.cer,.pem"
            chosen={certificate}
            error={certificateError}
            onChange={choose(setCertificate)}
          />
          <FileField
            key={`key-${String(round)}`}
            id="credential-key"
            label={t('credential.privateKey')}
            accept=".key,.pem"
            chosen={privateKey}
            error={keyError}
            onChange={choose(setPrivateKey)}
          />
          {missingFiles ? (
            <p role="alert" className="text-sm text-destructive">
              {t('credential.bothFiles')}
            </p>
          ) : null}
          {simulated ? (
            <p className="text-xs text-muted-foreground">{t('credential.devHint')}</p>
          ) : null}
          <div>
            <Button type="submit" loading={upload.isPending}>
              {upload.isPending ? t('credential.uploading') : t('credential.upload')}
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">{t('credential.profileFirst')}</p>
      )}
    </section>
  );
}

function FileField({
  id,
  label,
  accept,
  chosen,
  error,
  onChange,
}: {
  id: string;
  label: string;
  accept: string;
  chosen: Chosen | null;
  error: string | null;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const { t } = useTranslation('invoicing');
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="file"
        accept={accept}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={onChange}
      />
      {chosen ? (
        <p className="text-xs text-muted-foreground">
          {t('credential.chosen', { name: chosen.name })}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
