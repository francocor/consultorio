import { WAITLIST_ENTRY_STATUSES, type WaitlistEntryStatus } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { Hourglass, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { RequirePermission } from '../../app/guards.js';
import { useApi, useAppStatus } from '../../app/providers.js';
import { useMe } from '../../app/session.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Button } from '../../shared/ui/button.js';
import { Checkbox } from '../../shared/ui/checkbox.js';
import { Select } from '../../shared/ui/input.js';
import { Label } from '../../shared/ui/label.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../shared/ui/states/loading-skeleton.js';

import { waitlistApi, waitlistKeys, type WaitlistFilters } from './api/waitlist-api.js';
import { AddEntryDialog } from './components/AddEntryDialog.js';
import { CallPanel } from './components/CallPanel.js';
import { EntryCard } from './components/EntryCard.js';

/** The waitlist: who waits for what, the slots to fill by phone, and the entries to look after. */
export function WaitlistPage() {
  return (
    <RequirePermission anyOf={['waitlist.manage']}>
      <Waitlist />
    </RequirePermission>
  );
}

function Waitlist() {
  const { t } = useTranslation(['waitlist', 'common']);
  usePageTitle(t('waitlist:title'));
  const api = useApi();
  const me = useMe();
  const appStatus = useAppStatus();
  const readOnly = appStatus.readOnly || me.tenantStatus === 'read_only';
  const [status, setStatus] = useState<WaitlistEntryStatus | ''>('');
  const [unresponsive, setUnresponsive] = useState(false);
  const [adding, setAdding] = useState(false);

  const filters: WaitlistFilters = {
    ...(status === '' ? {} : { status }),
    ...(unresponsive ? { unresponsive: true } : {}),
  };
  const list = useQuery({
    queryKey: waitlistKeys.list(filters),
    queryFn: () => waitlistApi(api).list(filters),
    refetchInterval: 60_000,
  });
  const calls = useQuery({
    queryKey: waitlistKeys.calls,
    queryFn: () => waitlistApi(api).calls(),
    refetchInterval: 60_000,
  });

  const entries = list.data?.entries ?? [];
  const silent = calls.data?.unresponsive.length ?? 0;

  return (
    <div className="grid grid-cols-1 gap-4">
      <PageHeader
        title={t('waitlist:title')}
        description={t('waitlist:description')}
        className="mb-0"
        actions={
          <Button
            type="button"
            disabled={readOnly}
            onClick={() => {
              setAdding(true);
            }}
          >
            <Plus aria-hidden="true" />
            {t('waitlist:add.open')}
          </Button>
        }
      />
      {readOnly ? (
        <Alert tone="warning">
          <AlertDescription>{t('common:state.readOnly.disabledReason')}</AlertDescription>
        </Alert>
      ) : null}

      <CallPanel items={calls.data?.items ?? []} />

      {silent > 0 && !unresponsive ? (
        <Alert tone="warning">
          <AlertDescription>
            <span>{t('waitlist:unresponsive.notice', { count: silent })} </span>
            <Button
              type="button"
              variant="link"
              onClick={() => {
                setUnresponsive(true);
              }}
            >
              {t('waitlist:unresponsive.show')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="waitlist-status">{t('waitlist:filter.status')}</Label>
          <Select
            id="waitlist-status"
            value={status}
            className="w-56"
            onChange={(event) => {
              setStatus(event.target.value as WaitlistEntryStatus | '');
            }}
          >
            <option value="">{t('waitlist:filter.inPlay')}</option>
            {WAITLIST_ENTRY_STATUSES.map((option) => (
              <option key={option} value={option}>
                {t(`waitlist:status.${option}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-center gap-2 pb-2.5">
          <Checkbox
            id="waitlist-unresponsive"
            checked={unresponsive}
            onCheckedChange={(next) => {
              setUnresponsive(next === true);
            }}
          />
          <Label htmlFor="waitlist-unresponsive" className="font-normal">
            {t('waitlist:filter.unresponsive')}
          </Label>
        </div>
      </div>

      {list.isPending ? <ListSkeleton rows={3} /> : null}
      {list.isError ? (
        <ErrorState
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      ) : null}
      {list.isSuccess && entries.length === 0 ? (
        <EmptyState
          icon={Hourglass}
          title={t('waitlist:empty.title')}
          description={t(
            status === '' && !unresponsive
              ? 'waitlist:empty.description'
              : 'waitlist:empty.filtered',
          )}
        />
      ) : null}
      {entries.length > 0 ? (
        <ul aria-label={t('waitlist:list.caption')} className="grid gap-3">
          {entries.map((entry) => (
            <EntryCard key={entry.id} entry={entry} readOnly={readOnly} />
          ))}
        </ul>
      ) : null}

      {adding ? (
        <AddEntryDialog
          onClose={() => {
            setAdding(false);
          }}
        />
      ) : null}
    </div>
  );
}
