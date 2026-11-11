import type { PortalLinkDto } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatDate, formatNumber } from '../../../shared/lib/format.js';
import { PageHeader } from '../../../shared/ui/page-header.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { portalApi, portalKeys } from '../api/portal-api.js';
import { DownloadButton } from '../components/DownloadButton.js';
import { QueryState } from '../components/QueryState.js';

/** The size of a file in the unit a person reads. */
function sizeOf(
  bytes: number,
  t: (key: string, values?: Record<string, string>) => string,
): string {
  if (bytes < 1024) return t('documents.size.bytes', { value: formatNumber(bytes) });
  if (bytes < 1024 * 1024)
    return t('documents.size.kb', { value: formatNumber(Math.round(bytes / 1024)) });
  return t('documents.size.mb', { value: formatNumber(Math.round(bytes / (1024 * 1024))) });
}

/** The documents the consultorio shared with the patient, and nothing else. */
export function DocumentsSection({ link }: { link: PortalLinkDto }) {
  const { t } = useTranslation('portal');
  const api = portalApi(useApi());
  const query = useQuery({
    queryKey: portalKeys.section(link.id, 'documents'),
    queryFn: () => api.documents(),
  });
  return (
    <section>
      <PageHeader title={t('documents.title')} description={t('documents.description')} />
      <QueryState
        query={query}
        isEmpty={(data) => data.documents.length === 0}
        empty={
          <EmptyState
            icon={FileText}
            title={t('documents.empty.title')}
            description={t('documents.empty.description')}
          />
        }
      >
        {(data) => (
          <ul className="grid gap-3">
            {data.documents.map((document) => (
              <li
                key={document.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4"
              >
                <div className="grid min-w-0 gap-0.5">
                  <p className="flex items-start gap-2 font-medium">
                    <FileText
                      className="mt-0.5 size-4 shrink-0 text-primary-ink"
                      aria-hidden="true"
                    />
                    <span className="break-words">{document.name}</span>
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t(`documents.category.${document.category}`, {
                      defaultValue: t('documents.category.other'),
                    })}
                    {' · '}
                    {t('documents.sharedOn', { date: formatDate(document.sharedAt) })}
                    {' · '}
                    {sizeOf(document.sizeBytes, t)}
                  </p>
                </div>
                <DownloadButton
                  kind="documents"
                  id={document.id}
                  fileName={document.name}
                  label={t('documents.downloadLabel', { name: document.name })}
                />
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </section>
  );
}
