import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleCheck, Download, LinkIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../app/providers.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { downloadBlob } from '../../shared/lib/download.js';
import { formatDate } from '../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Button } from '../../shared/ui/button.js';
import { Skeleton } from '../../shared/ui/skeleton.js';

import { releaseLinkApi } from './api/release-link-api.js';

/** The answer for a link that does not work, the same for every reason it may not. */
function Unavailable() {
  const { t } = useTranslation('export');
  usePageTitle(t('release.unavailable.title'));
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border bg-card px-6 py-12 text-center">
      <span className="grid size-12 place-content-center rounded-full bg-muted text-muted-foreground">
        <LinkIcon className="size-6" aria-hidden="true" />
      </span>
      <h1 className="font-display text-xl font-semibold tracking-tight">
        {t('release.unavailable.title')}
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {t('release.unavailable.description')}
      </p>
    </div>
  );
}

/**
 * `/archive-release/{token}`: where a verified requester receives the records that were released to
 * them. The page opens the link without spending it; the single download is a button the person
 * presses, so a scanner that follows the address never uses it up. After the download the page says
 * the link is spent. An unknown, expired or spent link gets the generic unavailable answer.
 */
export function ArchiveReleasePage({ token }: { token: string }) {
  const { t } = useTranslation('export');
  const api = useApi();
  usePageTitle(t('release.title'));

  const link = useQuery({
    queryKey: ['archive-release', token],
    queryFn: () => releaseLinkApi(api).inspect(token),
    retry: false,
    staleTime: Infinity,
  });
  const download = useMutation({
    mutationFn: async () => {
      const file = await releaseLinkApi(api).redeem(token);
      downloadBlob(file.blob, file.filename ?? 'historia-clinica.zip');
    },
  });

  if (link.isPending) {
    return (
      <div className="grid gap-3" role="status" aria-label={t('release.loading')}>
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (link.isError) return <Unavailable />;
  if (download.isError) return <Unavailable />;

  if (download.isSuccess) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border bg-card px-6 py-12 text-center">
        <span className="grid size-12 place-content-center rounded-full bg-success-soft text-success-soft-foreground">
          <CircleCheck className="size-6" aria-hidden="true" />
        </span>
        <h1 className="font-display text-xl font-semibold tracking-tight">
          {t('release.done.title')}
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">{t('release.done.description')}</p>
      </div>
    );
  }

  return (
    <div className="grid gap-5 rounded-lg border bg-card p-6">
      <div className="grid gap-2">
        <h1 className="font-display text-xl font-semibold tracking-tight">{t('release.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('release.description')}</p>
      </div>
      <Alert tone="warning">
        <AlertDescription>
          {t('release.once', { date: formatDate(link.data.expiresAt) })}
        </AlertDescription>
      </Alert>
      <div>
        <Button
          loading={download.isPending}
          onClick={() => {
            download.mutate();
          }}
        >
          <Download aria-hidden="true" />
          {t('release.download')}
        </Button>
      </div>
    </div>
  );
}
