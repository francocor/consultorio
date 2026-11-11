import type { SessionSummary } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatDateTime } from '../../../shared/lib/format.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../shared/ui/card.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { authApi, SESSIONS_QUERY_KEY } from '../api/auth-api.js';
import { describeUserAgent } from '../describe-user-agent.js';

/** Where the account is signed in, with the option to close the sessions that are not this one. */
export function SessionsSection() {
  const { t } = useTranslation('auth');
  const api = useApi();
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => authApi(api).sessions(),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => authApi(api).revokeSession(id),
    onSuccess: async () => {
      toast.success(t('sessions.revoked'));
      await queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('sessions.title')}</CardTitle>
        <CardDescription>{t('sessions.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {sessions.isPending ? (
          <ListSkeleton rows={2} />
        ) : sessions.isError ? (
          <ErrorState
            error={sessions.error}
            onRetry={() => {
              void sessions.refetch();
            }}
          />
        ) : (
          <>
            <ul className="divide-y rounded-lg border">
              {sessions.data.sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  closing={revoke.isPending && revoke.variables === session.id}
                  onRevoke={() => {
                    revoke.mutate(session.id);
                  }}
                />
              ))}
            </ul>
            {sessions.data.sessions.every((session) => session.current) ? (
              <p className="mt-3 text-sm">
                <span className="font-medium">{t('sessions.empty.title')}</span>
                <span className="text-muted-foreground"> {t('sessions.empty.description')}</span>
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SessionRow({
  session,
  closing,
  onRevoke,
}: {
  session: SessionSummary;
  closing: boolean;
  onRevoke: () => void;
}) {
  const { t } = useTranslation('auth');
  const device = describeUserAgent(session.userAgent);
  return (
    <li className="flex flex-wrap items-center gap-3 p-4">
      <span className="grid size-10 shrink-0 place-content-center rounded-full bg-muted text-muted-foreground">
        <Laptop className="size-5" aria-hidden="true" />
      </span>
      <div className="grid min-w-0 flex-[1_1_14rem] gap-0.5 text-sm">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          <span>
            {device
              ? t('sessions.deviceNamed', { browser: device.browser, os: device.os })
              : t('sessions.unknownDevice')}
          </span>
          {session.current ? <Badge tone="success">{t('sessions.current')}</Badge> : null}
        </p>
        <p className="tabular text-muted-foreground">
          {t('sessions.lastSeen', { date: formatDateTime(session.lastSeenAt) })}
        </p>
        <p className="tabular text-muted-foreground">
          {t('sessions.created', { date: formatDateTime(session.createdAt) })}
          {session.ip ? ` · ${t('sessions.address', { ip: session.ip })}` : ''}
        </p>
      </div>
      {session.current ? null : (
        <Button variant="outline" size="sm" loading={closing} onClick={onRevoke}>
          <LogOut aria-hidden="true" />
          {t('sessions.revoke')}
        </Button>
      )}
    </li>
  );
}
