import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatDateTime } from '../../../shared/lib/format.js';
import { Badge } from '../../../shared/ui/badge.js';
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

import { ScrollableText } from './ScrollableText.js';

/**
 * Every published version of a template, newest first (informed-consent, "Template versioning":
 * earlier versions remain viewable). A signature points at the version its signer was shown, so a
 * version is never edited; this screen only reads.
 */
export function VersionsDialog({
  templateId,
  title,
  onClose,
}: {
  templateId: string;
  title: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('consent');
  const api = useApi();
  const detail = useQuery({
    queryKey: consentKeys.template(templateId),
    queryFn: () => consentApi(api).template(templateId),
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('versions.title', { title })}</DialogTitle>
          <DialogDescription>{t('versions.description')}</DialogDescription>
        </DialogHeader>
        {detail.isPending ? <ListSkeleton rows={3} /> : null}
        {detail.isError ? (
          <ErrorState
            error={detail.error}
            onRetry={() => {
              void detail.refetch();
            }}
          />
        ) : null}
        {detail.isSuccess && detail.data.versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('versions.none')}</p>
        ) : null}
        {detail.isSuccess && detail.data.versions.length > 0 ? (
          <ul aria-label={t('versions.listLabel')} className="grid gap-2">
            {detail.data.versions.map((version) => (
              <li key={version.id} className="rounded-lg border bg-card p-3">
                <details>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm font-medium">
                    <span>{t('templates.version', { number: version.number })}</span>
                    <span className="font-normal text-muted-foreground">
                      {t('versions.publishedAt', { date: formatDateTime(version.publishedAt) })}
                    </span>
                    {version.latest ? <Badge tone="success">{t('versions.current')}</Badge> : null}
                  </summary>
                  <div className="mt-3 grid gap-2">
                    <p className="text-sm font-medium">{version.title}</p>
                    <ScrollableText label={t('versions.textLabel', { number: version.number })}>
                      {version.body}
                    </ScrollableText>
                    <p className="break-all text-xs text-muted-foreground">
                      {t('versions.hash', { hash: version.contentHash })}
                    </p>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
