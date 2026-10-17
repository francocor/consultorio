import { USAGE_WARNING_PERCENT, type UsageState } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  CheckCircle2,
  CircleSlash,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { Badge, type BadgeTone } from '../../../shared/ui/badge.js';
import { Skeleton } from '../../../shared/ui/skeleton.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../shared/ui/table.js';

import { messagingApi, messagingKeys } from './api/messaging-api.js';

const STATE: Record<UsageState, { tone: BadgeTone; icon: LucideIcon }> = {
  unlimited: { tone: 'neutral', icon: CircleSlash },
  ok: { tone: 'success', icon: CheckCircle2 },
  warning: { tone: 'warning', icon: TriangleAlert },
  exhausted: { tone: 'danger', icon: OctagonAlert },
};

/**
 * The WhatsApp messages of the month per professional, before they are billed: counts only, with
 * the state of the quota (warning from 80%, exhausted at 100%). It names a state in words and an
 * icon, never in color alone.
 */
export function UsageSection() {
  const { t } = useTranslation('messaging');
  const api = useApi();
  const usage = useQuery({
    queryKey: messagingKeys.usage,
    queryFn: () => messagingApi(api).usage(),
  });

  return (
    <section aria-labelledby="usage-title" className="grid gap-3 rounded-lg border bg-card p-4">
      <div className="grid gap-0.5">
        <h3 id="usage-title" className="font-medium">
          {t('usage.title')}
        </h3>
        {usage.data ? (
          <p className="text-sm text-muted-foreground">
            {t('usage.description', { period: usage.data.period })}
          </p>
        ) : null}
      </div>
      {usage.isPending ? <Skeleton className="h-24 w-full" /> : null}
      {usage.isError ? (
        <ErrorState
          error={usage.error}
          onRetry={() => {
            void usage.refetch();
          }}
        />
      ) : null}
      {usage.data ? (
        usage.data.professionals.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('usage.empty')}</p>
        ) : (
          <TableContainer aria-label={t('usage.caption')}>
            <Table>
              <TableCaption>{t('usage.caption')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('usage.col.professional')}</TableHead>
                  <TableHead className="text-right">{t('usage.col.count')}</TableHead>
                  <TableHead className="text-right">{t('usage.col.limit')}</TableHead>
                  <TableHead>{t('usage.col.state')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usage.data.professionals.map((entry) => {
                  const { tone, icon: Icon } = STATE[entry.state];
                  return (
                    <TableRow key={entry.professionalId}>
                      <TableCell className="font-medium">
                        {entry.name ?? t('usage.unnamed')}
                      </TableCell>
                      <TableCell className="tabular text-right">{entry.count}</TableCell>
                      <TableCell className="tabular text-right">
                        {entry.limit ?? t('usage.noLimit')}
                      </TableCell>
                      <TableCell>
                        <Badge tone={tone}>
                          <Icon aria-hidden="true" />
                          {t(`usage.state.${entry.state}`, { percent: USAGE_WARNING_PERCENT })}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )
      ) : null}
    </section>
  );
}
