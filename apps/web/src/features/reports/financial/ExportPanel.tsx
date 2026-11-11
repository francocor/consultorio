import {
  EXPORT_FORMATS,
  type ExportFormat,
  type ExportKind,
  type ExportRequestDto,
} from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileX2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { downloadBlob } from '../../../shared/lib/download.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Button, WRAPPING_LABEL } from '../../../shared/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../shared/ui/card.js';
import { Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { billingApi, billingKeys, ErrorAlert } from '../../billing/index.js';
import type { ReportQuery } from '../api/reports-api.js';

const FORMAT_KEYS: Record<ExportFormat, string> = {
  csv: 'export.csv',
  xlsx: 'export.xlsx',
  pdf: 'export.pdf',
};

/** The export asked for, followed until the job finishes. */
function ExportStatus({ id }: { id: string }) {
  const { t } = useTranslation('reports');
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

  if (status.isPending || status.data?.status === 'queued') {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t('export.queued')}
      </p>
    );
  }
  if (status.isError) return <ErrorAlert error={status.error} />;
  const entry = status.data;
  if (entry.status === 'empty') {
    return (
      <Alert tone="info">
        <AlertDescription>
          <span className="inline-flex items-center gap-2 font-medium">
            <FileX2 aria-hidden="true" className="size-4" />
            {t('export.empty.title')}
          </span>
          <span>{t('export.empty.description')}</span>
        </AlertDescription>
      </Alert>
    );
  }
  if (entry.status === 'failed') {
    return (
      <Alert tone="danger">
        <AlertDescription>
          {entry.failureCode === 'export_too_large' ? t('export.tooLarge') : t('export.failed')}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="grid gap-2">
      <Alert tone="success">
        <AlertDescription>{t('export.ready', { count: entry.rowCount ?? 0 })}</AlertDescription>
      </Alert>
      <div>
        <Button
          type="button"
          className={WRAPPING_LABEL}
          loading={download.isPending}
          onClick={() => {
            download.mutate(entry);
          }}
        >
          <Download aria-hidden="true" />
          {t('export.download', { name: entry.fileName ?? '' })}
        </Button>
      </div>
      <ErrorAlert error={download.error} />
    </div>
  );
}

/**
 * The export buttons of a report (reports, "Report export"): CSV, Excel and PDF through the export
 * job of billing, with the filters on screen. The job applies the scope of the person on the server
 * (a professional's file only lists their own rows), writes the filters and the moment of generation
 * in the file and audits the request. An export is on the allowlist of a read-only organization, so
 * these buttons never depend on the state of the account.
 */
export function ExportPanel({
  kinds,
  query,
  filtersText,
}: {
  kinds: readonly ExportKind[];
  query: ReportQuery;
  /** The filters in words, as the screen shows them. */
  filtersText: string;
}) {
  const { t } = useTranslation('reports');
  const api = useApi();
  const queryClient = useQueryClient();
  const kindId = useId();
  const [kind, setKind] = useState<ExportKind>(kinds[0] ?? 'charges');
  const [requested, setRequested] = useState<string | null>(null);

  const request = useMutation({
    mutationFn: (format: ExportFormat) =>
      billingApi(api).requestExport({
        kind,
        format,
        from: query.from,
        to: query.to,
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(query.professionalId ? { professionalId: query.professionalId } : {}),
        ...(query.tenantPayerId ? { tenantPayerId: query.tenantPayerId } : {}),
      }),
    onSuccess: async (created) => {
      setRequested(created.id);
      await queryClient.invalidateQueries({ queryKey: billingKeys.exports });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('export.title')}</CardTitle>
        <CardDescription>{t('export.description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4">
        <p className="text-sm text-muted-foreground">
          {t('export.filters', { filters: filtersText })}
        </p>
        {kinds.length > 1 ? (
          <div className="grid max-w-sm gap-1.5">
            <Label htmlFor={kindId}>{t('export.kind')}</Label>
            <Select
              id={kindId}
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as ExportKind);
                setRequested(null);
              }}
            >
              {kinds.map((option) => (
                <option key={option} value={option}>
                  {t(`export.kinds.${option}`)}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <p className="text-sm font-medium">{t(`export.kinds.${kind}`)}</p>
        )}
        <div role="group" aria-label={t('export.formats')} className="flex flex-wrap gap-2">
          {EXPORT_FORMATS.map((format) => (
            <Button
              key={format}
              type="button"
              variant="outline"
              loading={request.isPending && request.variables === format}
              onClick={() => {
                if (!request.isPending) request.mutate(format);
              }}
            >
              {t(FORMAT_KEYS[format])}
            </Button>
          ))}
        </div>
        <ErrorAlert error={request.error} />
        {requested ? <ExportStatus id={requested} /> : null}
      </CardContent>
    </Card>
  );
}
