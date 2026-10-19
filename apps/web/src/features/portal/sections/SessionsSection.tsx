import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MonitorSmartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatDateTime } from '../../../shared/lib/format.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import { PageHeader } from '../../../shared/ui/page-header.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { toast } from '../../../shared/ui/toaster.js';
import { portalApi, portalKeys } from '../api/portal-api.js';
import { QueryState } from '../components/QueryState.js';

/** The devices where the account is signed in, and the way to end any of them but this one. */
export function SessionsSection() {
  const { t } = useTranslation('portal');
  const api = portalApi(useApi());
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: portalKeys.sessions, queryFn: () => api.sessions() });
  const end = useMutation({
    mutationFn: (id: string) => api.endSession(id),
    onSuccess: async () => {
      toast.success(t('sessions.ended'));
      await queryClient.invalidateQueries({ queryKey: portalKeys.sessions });
    },
  });
  return (
    <section>
      <PageHeader title={t('sessions.title')} description={t('sessions.description')} />
      {end.error ? (
        <Alert tone="danger" className="mb-4">
          <AlertDescription>{describeError(t, end.error).message}</AlertDescription>
        </Alert>
      ) : null}
      <QueryState
        query={query}
        isEmpty={(data) => data.sessions.length === 0}
        empty={<EmptyState icon={MonitorSmartphone} title={t('sessions.empty')} />}
      >
        {(data) => (
          <ul className="grid gap-3">
            {data.sessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4"
              >
                <div className="grid min-w-0 gap-1 text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <MonitorSmartphone className="size-4 shrink-0" aria-hidden="true" />
                    <span className="break-words">
                      {session.userAgent ?? t('sessions.unknownDevice')}
                    </span>
                    {session.current ? <Badge tone="info">{t('sessions.current')}</Badge> : null}
                  </p>
                  <p className="text-muted-foreground">
                    {t('sessions.lastSeen', { when: formatDateTime(session.lastSeenAt) })}
                  </p>
                </div>
                {session.current ? null : (
                  <Button
                    variant="outline"
                    size="sm"
                    loading={end.isPending}
                    onClick={() => {
                      end.mutate(session.id);
                    }}
                  >
                    {t('sessions.end')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </section>
  );
}
