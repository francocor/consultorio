import type { DocumentDto } from '@consultorio/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { downloadBlob } from '../../../shared/lib/download.js';
import { formatDateTime } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Badge } from '../../../shared/ui/badge.js';
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
import { toast } from '../../../shared/ui/toaster.js';
import { documentKeys, documentsApi } from '../api/documents-api.js';
import { formatFileSize } from '../domain/file-size.js';

import { DocumentStatusBadge } from './DocumentStatus.js';

/** Every version of a document, newest first. The old ones stay downloadable: nothing is replaced in place. */
export function VersionsDialog({
  document,
  canDownload,
  onOpenChange,
}: {
  document: DocumentDto | null;
  canDownload: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(['documents', 'common']);
  const api = useApi();
  const id = document?.id ?? '';

  const versions = useQuery({
    queryKey: documentKeys.versions(id),
    queryFn: () => documentsApi(api).versions(id),
    enabled: document !== null,
  });

  const download = useMutation({
    mutationFn: async (version: DocumentDto) => {
      const file = await documentsApi(api).download(version.id);
      downloadBlob(file.blob, version.name);
    },
    onError: (error) => {
      toast.error(describeError(t, error).message);
    },
  });

  return (
    <Dialog open={document !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('documents:versions.title', { name: document?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('documents:versions.description')}</DialogDescription>
        </DialogHeader>
        {versions.isPending ? <ListSkeleton rows={2} /> : null}
        {versions.isError ? (
          <ErrorState
            error={versions.error}
            onRetry={() => {
              void versions.refetch();
            }}
          />
        ) : null}
        {versions.data ? (
          <ol className="grid gap-2">
            {versions.data.versions.map((version, index) => (
              <li
                key={version.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="grid min-w-0 gap-0.5">
                  <span className="break-words font-medium">{version.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {formatDateTime(version.uploadedAt)} · {formatFileSize(version.size)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {index === 0 ? (
                    <Badge tone="brand">{t('documents:versions.current')}</Badge>
                  ) : null}
                  <DocumentStatusBadge status={version.status} />
                  {canDownload && version.status === 'available' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t('documents:action.downloadNamed', {
                        name: `${version.name} (${formatDateTime(version.uploadedAt)})`,
                      })}
                      loading={download.isPending && download.variables.id === version.id}
                      onClick={() => {
                        download.mutate(version);
                      }}
                    >
                      <Download aria-hidden="true" />
                      {t('documents:action.download')}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
