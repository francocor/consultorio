import { useQuery } from '@tanstack/react-query';
import { FilePen, MessageSquarePlus, OctagonAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatDate, formatTime } from '../../../shared/lib/format.js';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../../shared/ui/sheet.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { clinicalApi, clinicalKeys } from '../api/clinical-api.js';

import { authorName } from './NoteView.js';

interface VersionsSheetProps {
  noteId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The history of an entry in a side drawer: the signed version with its hash, every addendum and
 * the "entered in error" mark, in order, with who and when. Opening it is an audited read. Nothing
 * here can be removed.
 */
export function VersionsSheet({ noteId, open, onOpenChange }: VersionsSheetProps) {
  const { t } = useTranslation('clinical');
  const api = useApi();
  const history = useQuery({
    queryKey: clinicalKeys.history(noteId),
    queryFn: () => clinicalApi(api).history(noteId),
    enabled: open,
    // Every opening is a read that must be audited: never serve it from the cache.
    gcTime: 0,
    staleTime: 0,
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[28rem] overflow-y-auto">
        <div className="grid gap-1.5">
          <SheetTitle>{t('versions.title')}</SheetTitle>
          <SheetDescription>{t('versions.description')}</SheetDescription>
        </div>
        {history.isPending ? (
          <div aria-label={t('versions.loading')}>
            <ListSkeleton rows={3} />
          </div>
        ) : history.isError ? (
          <ErrorState
            error={history.error}
            onRetry={() => {
              void history.refetch();
            }}
          />
        ) : (
          <ol className="grid gap-3">
            {history.data.items.map((item, index) => {
              const when = {
                date: formatDate(item.at),
                time: formatTime(item.at),
                name: authorName(t, item.author),
              };
              return (
                <li key={index} className="grid gap-1 rounded-md border p-3">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {item.type === 'version' ? (
                      <FilePen className="size-4" aria-hidden="true" />
                    ) : item.type === 'addendum' ? (
                      <MessageSquarePlus className="size-4" aria-hidden="true" />
                    ) : (
                      <OctagonAlert className="size-4" aria-hidden="true" />
                    )}
                    {item.type === 'version'
                      ? t('versions.version', { n: item.versionNo })
                      : item.type === 'addendum'
                        ? `${t('versions.addendum')}: ${t(`entry.addendum.kind.${item.kind}`)}`
                        : t('versions.error')}
                  </p>
                  <p className="text-sm text-muted-foreground">{t('versions.by', when)}</p>
                  {item.type !== 'version' ? <p className="text-sm">{item.reason}</p> : null}
                  {item.type !== 'entered_in_error' ? (
                    <code className="break-all text-xs text-muted-foreground">
                      {t('versions.hash', { hash: item.contentHash.slice(0, 16) })}
                    </code>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </SheetContent>
    </Sheet>
  );
}
