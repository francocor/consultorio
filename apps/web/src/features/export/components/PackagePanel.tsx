import { useMutation, useQuery } from '@tanstack/react-query';
import { Download, PackageOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { downloadBlob } from '../../../shared/lib/download.js';
import { formatDateTime } from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button, WRAPPING_LABEL } from '../../../shared/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../shared/ui/card.js';
import { Skeleton } from '../../../shared/ui/skeleton.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { exportApi, exportKeys, type ExportAudience } from '../api/export-api.js';

import { ErrorAlert } from './ErrorAlert.js';

/** How often the screen looks again while the package is still being made. */
const POLL_MS = 3000;

/** The words of each audience. Literal keys, so the missing-key checks of the tests see them. */
const WORDS = {
  administrative: {
    noneTitle: 'administrative.none.title',
    noneDescription: 'administrative.none.description',
    queued: 'administrative.queued.description',
    readyTitle: 'administrative.ready.title',
    readyDescription: 'administrative.ready.description',
    download: 'administrative.download',
  },
  clinical: {
    noneTitle: 'clinical.none.title',
    noneDescription: 'clinical.none.description',
    queued: 'clinical.queued.description',
    readyTitle: 'clinical.ready.title',
    readyDescription: 'clinical.ready.description',
    download: 'clinical.download',
  },
} as const;

/** Megabytes with one decimal, or kilobytes when it is small: a size a person can read. */
function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}

/**
 * The package of the cancellation export for one audience (the owner's administrative package or a
 * professional's clinical one): where it stands, and the download once it is ready. The same panel
 * serves both pages. The state is looked at again every few seconds while the package is being made.
 */
export function PackagePanel({ audience }: { audience: ExportAudience }) {
  const { t } = useTranslation('export');
  const api = useApi();
  const words = WORDS[audience];
  const state = useQuery({
    queryKey: exportKeys.package(audience),
    queryFn: () => exportApi(api).state(audience),
    refetchInterval: (query) => (query.state.data?.package?.status === 'queued' ? POLL_MS : false),
  });
  const download = useMutation({
    mutationFn: async () => {
      const file = await exportApi(api).download(audience);
      downloadBlob(file.blob, file.filename ?? state.data?.package?.fileName ?? 'exportacion.zip');
    },
  });

  if (state.isPending) {
    return (
      <div role="status" aria-label={t('loading')} className="grid gap-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (state.isError) {
    return (
      <ErrorState
        error={state.error}
        onRetry={() => {
          void state.refetch();
        }}
      />
    );
  }

  const entry = state.data.package;
  if (entry === null) {
    return (
      <EmptyState
        icon={PackageOpen}
        title={t(words.noneTitle)}
        description={t(words.noneDescription)}
      />
    );
  }
  if (entry.status === 'queued') {
    return (
      <Alert tone="info">
        <AlertDescription>
          <span className="font-medium">{t('queued.title')}</span>
          <span>{t(words.queued)}</span>
        </AlertDescription>
      </Alert>
    );
  }
  if (entry.status === 'failed') {
    return (
      <Alert tone="danger">
        <AlertDescription>
          <span className="font-medium">{t('failed.title')}</span>
          <span>
            {entry.failureCode === 'package_too_large'
              ? t('failed.package_too_large')
              : entry.failureCode === 'clinical_key_in_administrative_part'
                ? t('failed.clinical_key_in_administrative_part')
                : t('failed.build_failed')}
          </span>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(words.readyTitle)}</CardTitle>
        <CardDescription>{t(words.readyDescription)}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">{t('file.name')}</dt>
            <dd className="break-all font-medium">{entry.fileName ?? ''}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('file.size')}</dt>
            <dd className="font-medium">{sizeText(entry.sizeBytes ?? 0)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('file.builtAt')}</dt>
            <dd className="font-medium">{formatDateTime(entry.builtAt)}</dd>
          </div>
        </dl>
        <div>
          <Button
            type="button"
            className={WRAPPING_LABEL}
            loading={download.isPending}
            onClick={() => {
              download.mutate();
            }}
          >
            <Download aria-hidden="true" />
            {t(words.download)}
          </Button>
        </div>
        <ErrorAlert error={download.error} />
      </CardContent>
    </Card>
  );
}
