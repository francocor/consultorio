import {
  EXPORT_FORMATS,
  EXPORT_KINDS,
  type ExportFormat,
  type ExportKind,
  type ExportRequestDto,
} from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileX2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { downloadBlob } from '../../../shared/lib/download.js';
import { formatDate } from '../../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button } from '../../../shared/ui/button.js';
import { Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { billingApi, billingKeys } from '../api/billing-api.js';

import { ErrorAlert } from './ErrorAlert.js';

/** The export asked for, followed until the job finishes. */
function ExportStatus({ id }: { id: string }) {
  const { t } = useTranslation('billing');
  const api = useApi();
  const status = useQuery({
    queryKey: [...billingKeys.exports, id],
    queryFn: () => billingApi(api).exportStatus(id),
    // The job runs in the background: look again until it ends.
    refetchInterval: (query) => (query.state.data?.status === 'queued' ? 1500 : false),
  });
  const download = useMutation({
    mutationFn: async (entry: ExportRequestDto) => {
      const file = await billingApi(api).downloadExport(entry.id);
      downloadBlob(file.blob, file.filename ?? entry.fileName ?? 'exportacion');
    },
  });

  if (status.isPending)
    return <p className="text-sm text-muted-foreground">{t('exports.queued')}</p>;
  if (status.isError) return <ErrorAlert error={status.error} />;
  const entry = status.data;

  if (entry.status === 'queued') {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t('exports.queued')}
      </p>
    );
  }
  if (entry.status === 'empty') {
    return (
      <Alert tone="info">
        <AlertDescription>
          <span className="inline-flex items-center gap-2 font-medium">
            <FileX2 aria-hidden="true" className="size-4" />
            {t('exports.empty.title')}
          </span>
          <span>{t('exports.empty.description')}</span>
        </AlertDescription>
      </Alert>
    );
  }
  if (entry.status === 'failed') {
    return (
      <Alert tone="danger">
        <AlertDescription>
          {entry.failureCode === 'export_too_large' ? t('exports.tooLarge') : t('exports.failed')}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="grid gap-2">
      <Alert tone="success">
        <AlertDescription>{t('exports.ready', { count: entry.rowCount ?? 0 })}</AlertDescription>
      </Alert>
      <div>
        <Button
          type="button"
          loading={download.isPending}
          onClick={() => {
            download.mutate(entry);
          }}
        >
          <Download aria-hidden="true" />
          {t('exports.download', { name: entry.fileName ?? '' })}
        </Button>
      </div>
      <ErrorAlert error={download.error} />
    </div>
  );
}

/**
 * Asks for an export of charges, payments or the payer settlement for the period on screen, in one
 * of three formats. The file is built in the background and downloaded through a link made for this
 * session; a period with nothing to list says so instead of handing over a blank file.
 */
export function ExportsPanel({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation('billing');
  const api = useApi();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ExportKind>('charges');
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [requested, setRequested] = useState<string | null>(null);

  const request = useMutation({
    mutationFn: () => billingApi(api).requestExport({ kind, format, from, to }),
    onSuccess: async (created) => {
      setRequested(created.id);
      await queryClient.invalidateQueries({ queryKey: billingKeys.exports });
    },
  });

  return (
    <div className="grid max-w-xl gap-4">
      <p className="text-sm text-muted-foreground">
        {t('exports.period', {
          from: formatDate(`${from}T12:00:00Z`),
          to: formatDate(`${to}T12:00:00Z`),
        })}
      </p>
      <div className="grid gap-1.5">
        <Label htmlFor="export-kind">{t('exports.kind')}</Label>
        <Select
          id="export-kind"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as ExportKind);
            setRequested(null);
          }}
        >
          {EXPORT_KINDS.map((option) => (
            <option key={option} value={option}>
              {t(`exports.kinds.${option}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="export-format">{t('exports.format')}</Label>
        <Select
          id="export-format"
          value={format}
          onChange={(event) => {
            setFormat(event.target.value as ExportFormat);
            setRequested(null);
          }}
        >
          {EXPORT_FORMATS.map((option) => (
            <option key={option} value={option}>
              {t(`exports.formats.${option}`)}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Button
          type="button"
          loading={request.isPending}
          onClick={() => {
            if (!request.isPending) request.mutate();
          }}
        >
          {t('exports.request')}
        </Button>
      </div>
      <ErrorAlert error={request.error} />
      {requested ? <ExportStatus id={requested} /> : null}
    </div>
  );
}
