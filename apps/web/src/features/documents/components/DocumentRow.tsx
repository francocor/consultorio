import type { DocumentDto } from '@consultorio/contracts';
import { Download, EyeOff, History, Replace } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { formatDate } from '../../../shared/lib/format.js';
import { Button } from '../../../shared/ui/button.js';
import { formatFileSize } from '../domain/file-size.js';

import { ClassificationBadge, DocumentStatusBadge } from './DocumentStatus.js';

export interface DocumentRowProps {
  document: DocumentDto;
  /** May this user download documents of this classification? */
  canDownload: boolean;
  /** May this user hide or replace documents of this classification? */
  canManage: boolean;
  downloading: boolean;
  onDownload: (document: DocumentDto) => void;
  onHide: (document: DocumentDto) => void;
  onReplace: (document: DocumentDto) => void;
  onVersions: (document: DocumentDto) => void;
}

/** One document of the list: what it is, who put it there, its state, and what can be done with it. */
export function DocumentRow({
  document,
  canDownload,
  canManage,
  downloading,
  onDownload,
  onHide,
  onReplace,
  onVersions,
}: DocumentRowProps) {
  const { t } = useTranslation(['documents', 'common']);
  const date = formatDate(document.uploadedAt);
  const uploadedBy = document.uploadedByName
    ? t('documents:row.uploadedBy', { name: document.uploadedByName, date })
    : t('documents:row.uploadedOn', { date });
  const available = document.status === 'available' && !document.metadataOnly;

  return (
    <li className="grid gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h3 className="break-words font-medium">{document.name}</h3>
          <p className="text-sm text-muted-foreground">
            {t(`documents:category.${document.category}`)} · {formatFileSize(document.size)}
          </p>
          <p className="text-sm text-muted-foreground">{uploadedBy}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ClassificationBadge classification={document.classification} />
          {document.metadataOnly ? null : <DocumentStatusBadge status={document.status} />}
        </div>
      </div>

      {document.status === 'quarantined' ? (
        <p className="text-sm text-muted-foreground">{t('documents:status.scanningHint')}</p>
      ) : null}
      {document.status === 'rejected' && document.rejectionReason ? (
        <p className="text-sm text-danger-soft-foreground">
          {t(`documents:rejection.${document.rejectionReason}`)}
        </p>
      ) : null}
      {document.hidden ? (
        <p className="text-sm text-muted-foreground">
          {t('documents:row.hiddenReason', { reason: document.hidden.reason })}
        </p>
      ) : null}
      {document.duplicateOf ? (
        <p className="text-sm text-muted-foreground">
          {t('documents:row.duplicateOf', { name: document.duplicateOf.name })}
        </p>
      ) : null}
      {document.metadataOnly ? (
        <p className="text-sm text-muted-foreground">{t('documents:row.metadataOnly')}</p>
      ) : null}

      {available || (document.versionCount > 1 && !document.metadataOnly) ? (
        <div className="flex flex-wrap gap-2">
          {available && canDownload ? (
            <Button
              variant="outline"
              size="sm"
              loading={downloading}
              aria-label={t('documents:action.downloadNamed', { name: document.name })}
              onClick={() => {
                onDownload(document);
              }}
            >
              <Download aria-hidden="true" />
              {t('documents:action.download')}
            </Button>
          ) : null}
          {document.versionCount > 1 ? (
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('documents:action.versionsNamed', { name: document.name })}
              onClick={() => {
                onVersions(document);
              }}
            >
              <History aria-hidden="true" />
              {t('documents:row.versions', { count: document.versionCount })}
            </Button>
          ) : null}
          {available && canManage ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('documents:action.replaceNamed', { name: document.name })}
                onClick={() => {
                  onReplace(document);
                }}
              >
                <Replace aria-hidden="true" />
                {t('documents:action.replace')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('documents:action.hideNamed', { name: document.name })}
                onClick={() => {
                  onHide(document);
                }}
              >
                <EyeOff aria-hidden="true" />
                {t('documents:action.hide')}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
