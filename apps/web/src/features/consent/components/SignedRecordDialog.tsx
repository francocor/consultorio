import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { downloadBlob } from '../../../shared/lib/download.js';
import { formatDateTime } from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { consentApi, consentKeys } from '../api/consent-api.js';

import { ErrorAlert } from './ErrorAlert.js';
import { ScrollableText } from './ScrollableText.js';

/**
 * The signed record, for a professional who may read it (`clinical.consent.read`): the text that
 * was signed, who signed it and how, and the fingerprint with the result of checking it. Opening it
 * is audited by the server (every read of a signed consent is). The printable document is the same
 * record as a PDF.
 */
export function SignedRecordDialog({
  requestId,
  onClose,
}: {
  requestId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(['consent', 'common']);
  const api = useApi();
  const [downloadError, setDownloadError] = useState<unknown>(null);
  const [downloading, setDownloading] = useState(false);

  const record = useQuery({
    queryKey: consentKeys.record(requestId),
    queryFn: () => consentApi(api).record(requestId),
    // Each opening is a read to audit: never serve it from the cache.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const download = async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      const file = await consentApi(api).document(requestId);
      downloadBlob(file.blob, file.filename ?? `consentimiento-${requestId}.pdf`);
    } catch (error) {
      setDownloadError(error);
    } finally {
      setDownloading(false);
    }
  };

  const data = record.data;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('consent:record.title')}</DialogTitle>
          <DialogDescription>{t('consent:record.description')}</DialogDescription>
        </DialogHeader>
        {record.isPending ? <ListSkeleton rows={4} /> : null}
        {record.isError ? (
          <ErrorState
            error={record.error}
            onRetry={() => {
              void record.refetch();
            }}
          />
        ) : null}
        {data ? (
          <div className="grid gap-4">
            <section className="grid gap-2">
              <h3 className="font-display text-base font-semibold">{data.version.title}</h3>
              <p className="text-sm text-muted-foreground">
                {t('consent:signing.version', { number: data.version.number })}
              </p>
              <ScrollableText label={t('consent:signing.textLabel')}>
                {data.version.body}
              </ScrollableText>
            </section>
            <dl className="grid gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
              <dt className="font-medium">{t('consent:record.signedBy')}</dt>
              <dd>
                {data.signerKind === 'representative' && data.representative
                  ? t('consent:record.signer.representative', {
                      name: data.representative.name,
                      relation: data.representative.relation,
                    })
                  : t('consent:record.signer.patient')}
              </dd>
              <dt className="font-medium">{t('consent:record.signedAt')}</dt>
              <dd>{formatDateTime(data.signedAt)}</dd>
              <dt className="font-medium">{t('consent:record.method')}</dt>
              <dd>{t(`consent:method.${data.method}`)}</dd>
              <dt className="font-medium">{t('consent:record.mark')}</dt>
              <dd>
                {data.mark.kind === 'typed' ? (
                  data.mark.name
                ) : (
                  <img
                    src={data.mark.imageDataUrl}
                    alt={t('consent:record.markImage')}
                    className="h-16 rounded border bg-white"
                  />
                )}
              </dd>
              <dt className="font-medium">{t('consent:record.fingerprint')}</dt>
              <dd className="break-all font-mono text-xs">{data.contentFingerprint}</dd>
            </dl>
            <Alert tone={data.fingerprintValid ? 'success' : 'danger'}>
              <AlertDescription>
                {data.fingerprintValid
                  ? t('consent:record.fingerprintValid')
                  : t('consent:record.fingerprintInvalid')}
              </AlertDescription>
            </Alert>
            {data.revocation ? (
              <Alert tone="warning">
                <AlertDescription>
                  {t('consent:record.revoked', { date: formatDateTime(data.revocation.revokedAt) })}
                  {data.revocation.reason
                    ? ` ${t('consent:record.revokedReason', { reason: data.revocation.reason })}`
                    : ''}
                </AlertDescription>
              </Alert>
            ) : null}
            <ErrorAlert error={downloadError} />
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                loading={downloading}
                onClick={() => {
                  void download();
                }}
              >
                <Download aria-hidden="true" />
                {t('consent:record.download')}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
