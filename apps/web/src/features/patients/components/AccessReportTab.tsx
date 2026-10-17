import { useInfiniteQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { Button } from '../../../shared/ui/button.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { auditApi, auditKeys } from '../../audit/api/audit-api.js';
import { AuditEventsTable } from '../../audit/components/AuditEventsTable.js';

import { Section } from './Section.js';

/** Who consulted or changed this record: the access report, for whoever can read the audit trail. */
export function AccessReportTab({ patientId }: { patientId: string }) {
  const { t } = useTranslation('audit');
  const api = useApi();
  const report = useInfiniteQuery({
    queryKey: auditKeys.accessReport(patientId),
    queryFn: ({ pageParam }) => auditApi(api).accessReport(patientId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  if (report.isPending) return <ListSkeleton rows={3} />;
  if (report.isError) {
    return (
      <ErrorState
        error={report.error}
        onRetry={() => {
          void report.refetch();
        }}
      />
    );
  }
  const events = report.data.pages.flatMap((page) => page.events);
  if (events.length === 0) {
    return (
      <EmptyState
        icon={ScrollText}
        title={t('accessReport.empty')}
        description={t('accessReport.description')}
      />
    );
  }
  return (
    <Section title={t('accessReport.title')} description={t('accessReport.description')}>
      <div className="grid gap-4">
        <AuditEventsTable events={events} />
        {report.hasNextPage ? (
          <div className="flex justify-center">
            <Button
              variant="outline"
              loading={report.isFetchingNextPage}
              onClick={() => {
                void report.fetchNextPage();
              }}
            >
              {t('loadMore')}
            </Button>
          </div>
        ) : null}
      </div>
    </Section>
  );
}
