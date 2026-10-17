import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FilePen, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { cn } from '../../shared/lib/cn.js';
import { formatDate, formatTime } from '../../shared/lib/format.js';
import { Badge } from '../../shared/ui/badge.js';
import { buttonVariants } from '../../shared/ui/button.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../shared/ui/states/loading-skeleton.js';

import { clinicalApi, clinicalKeys } from './api/clinical-api.js';

/** The professional's own unsigned notes, most recently edited first. Nobody else sees them. */
export function DraftsPage() {
  const { t } = useTranslation('clinical');
  const api = useApi();
  usePageTitle(t('drafts.title'));
  const drafts = useQuery({
    queryKey: clinicalKeys.drafts,
    queryFn: () => clinicalApi(api).drafts(),
    // A draft changes while it is being written elsewhere: always ask again.
    staleTime: 0,
  });

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t('drafts.title')} description={t('drafts.description')} />
      {drafts.isPending ? <ListSkeleton rows={3} /> : null}
      {drafts.isError ? (
        <ErrorState
          error={drafts.error}
          onRetry={() => {
            void drafts.refetch();
          }}
        />
      ) : null}
      {drafts.data && drafts.data.drafts.length === 0 ? (
        <EmptyState
          icon={FilePen}
          title={t('drafts.empty.title')}
          description={t('drafts.empty.description')}
        />
      ) : null}
      {drafts.data && drafts.data.drafts.length > 0 ? (
        <ul aria-label={t('drafts.list')} className="grid gap-3">
          {drafts.data.drafts.map((draft) => (
            <li
              key={draft.noteId}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4"
            >
              <div className="grid gap-1">
                <p className="font-medium">{draft.patientName}</p>
                <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <Badge tone="brand">{t(`template.${draft.templateKind}`)}</Badge>
                  {draft.visibility === 'author_only' ? (
                    <Badge tone="warning">
                      <Lock aria-hidden="true" />
                      {t('visibility.author_only')}
                    </Badge>
                  ) : null}
                  {t('drafts.updated', {
                    date: formatDate(draft.updatedAt),
                    time: formatTime(draft.updatedAt),
                  })}
                </p>
              </div>
              <Link
                to="/notes/$noteId"
                params={{ noteId: draft.noteId }}
                className={cn(buttonVariants())}
              >
                {t('drafts.continue')}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
