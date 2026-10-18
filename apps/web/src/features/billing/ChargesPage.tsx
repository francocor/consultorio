import { CHARGE_STATUSES, type ChargeDto, type ChargeStatus } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { Receipt } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { RequirePermission } from '../../app/guards.js';
import { useApi, useAppStatus } from '../../app/providers.js';
import { hasAnyPermission, useMe } from '../../app/session.js';
import { SimulatedBillingNotice } from '../../app/SimulatedBillingNotice.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { DEFAULT_TIME_ZONE, formatMoney, formatTime } from '../../shared/lib/format.js';
import { Button } from '../../shared/ui/button.js';
import { Checkbox } from '../../shared/ui/checkbox.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../shared/ui/dialog.js';
import { Input, Select } from '../../shared/ui/input.js';
import { Label } from '../../shared/ui/label.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../shared/ui/tabs.js';

import { billingApi, billingKeys, type ChargeFilters } from './api/billing-api.js';
import { ChargeBody } from './components/ChargeBody.js';
import { ChargeStatusBadge } from './components/ChargeStatusBadge.js';
import { ExportsPanel } from './components/ExportsPanel.js';
import { ReceivablesPanel } from './components/ReceivablesPanel.js';
import { dayInZone } from './domain/days.js';

/** The charges: what is owed for the appointments of a period, by state, and what to do with each. */
export function ChargesPage() {
  return (
    <RequirePermission anyOf={['payments.read']}>
      <Charges />
    </RequirePermission>
  );
}

function ChargeCard({ charge, onOpen }: { charge: ChargeDto; onOpen: () => void }) {
  const { t } = useTranslation('billing');
  return (
    <li className="grid gap-2 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{charge.patientName}</p>
          <p className="text-sm text-muted-foreground">
            {formatTime(charge.startsAt)} · {charge.appointmentTypeName} · {charge.professionalName}
          </p>
        </div>
        <ChargeStatusBadge status={charge.status} />
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="text-muted-foreground">
          {t('list.total')}: <span className="tabular-nums">{formatMoney(charge.totalCents)}</span>
        </span>
        <span>
          {t('list.outstanding')}:{' '}
          <span className="tabular-nums font-semibold">{formatMoney(charge.outstandingCents)}</span>
        </span>
      </div>
      {charge.needsReview && charge.status !== 'voided' ? (
        <p className="text-sm font-medium text-warning-soft-foreground">{t('list.needsReview')}</p>
      ) : null}
      <div>
        <Button type="button" size="sm" variant="outline" onClick={onOpen}>
          {t('list.open', { patient: charge.patientName })}
        </Button>
      </div>
    </li>
  );
}

function Charges() {
  const { t } = useTranslation(['billing', 'common']);
  usePageTitle(t('billing:title'));
  const api = useApi();
  const me = useMe();
  const appStatus = useAppStatus();
  const readOnly = appStatus.readOnly || me.tenantStatus === 'read_only';
  const today = dayInZone(new Date(), DEFAULT_TIME_ZONE);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState<ChargeStatus | ''>('');
  const [onlyReview, setOnlyReview] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const valid = from !== '' && to !== '' && from <= to;
  const filters: ChargeFilters = {
    from,
    to,
    ...(status === '' ? {} : { status }),
    ...(onlyReview ? { needsReview: true } : {}),
  };
  const list = useQuery({
    queryKey: billingKeys.charges(filters),
    queryFn: () => billingApi(api).charges(filters),
    // A period that ends before it starts is not asked of the server.
    enabled: valid,
  });
  const charges = list.data?.charges ?? [];
  const opened = charges.find((entry) => entry.id === openId);
  const canSeePayers = hasAnyPermission(me.permissions, ['payments.read']);

  return (
    <div className="grid grid-cols-1 gap-4">
      <PageHeader
        title={t('billing:title')}
        description={t('billing:description')}
        className="mb-0"
      />
      <SimulatedBillingNotice />

      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="charges-from">{t('billing:filter.from')}</Label>
          <Input
            id="charges-from"
            type="date"
            value={from}
            className="w-44"
            onChange={(event) => {
              setFrom(event.target.value);
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="charges-to">{t('billing:filter.to')}</Label>
          <Input
            id="charges-to"
            type="date"
            value={to}
            className="w-44"
            onChange={(event) => {
              setTo(event.target.value);
            }}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="charges-status">{t('billing:filter.status')}</Label>
          <Select
            id="charges-status"
            value={status}
            className="w-48"
            onChange={(event) => {
              setStatus(event.target.value as ChargeStatus | '');
            }}
          >
            <option value="">{t('billing:filter.anyStatus')}</option>
            {CHARGE_STATUSES.map((option) => (
              <option key={option} value={option}>
                {t(`billing:status.${option}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-center gap-2 pb-2.5">
          <Checkbox
            id="charges-review"
            checked={onlyReview}
            onCheckedChange={(next) => {
              setOnlyReview(next === true);
            }}
          />
          <Label htmlFor="charges-review" className="font-normal">
            {t('billing:filter.needsReview')}
          </Label>
        </div>
      </div>
      {!valid ? (
        <p className="text-sm text-danger-soft-foreground">{t('billing:filter.invalidPeriod')}</p>
      ) : null}

      <Tabs defaultValue="charges">
        <TabsList>
          <TabsTrigger value="charges">{t('billing:tabs.charges')}</TabsTrigger>
          {canSeePayers ? (
            <TabsTrigger value="receivables">{t('billing:tabs.receivables')}</TabsTrigger>
          ) : null}
          <TabsTrigger value="exports">{t('billing:tabs.exports')}</TabsTrigger>
        </TabsList>

        <TabsContent value="charges" className="grid gap-3 pt-4">
          {valid && list.isPending ? <ListSkeleton rows={3} /> : null}
          {list.isError ? (
            <ErrorState
              error={list.error}
              onRetry={() => {
                void list.refetch();
              }}
            />
          ) : null}
          {list.isSuccess && charges.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title={t('billing:empty.title')}
              description={t('billing:empty.description')}
            />
          ) : null}
          {charges.length > 0 ? (
            <ul aria-label={t('billing:list.caption')} className="grid gap-3">
              {charges.map((charge) => (
                <ChargeCard
                  key={charge.id}
                  charge={charge}
                  onOpen={() => {
                    setOpenId(charge.id);
                  }}
                />
              ))}
            </ul>
          ) : null}
        </TabsContent>

        {canSeePayers ? (
          <TabsContent value="receivables" className="pt-4">
            {valid ? <ReceivablesPanel from={from} to={to} /> : null}
          </TabsContent>
        ) : null}

        <TabsContent value="exports" className="pt-4">
          {valid ? <ExportsPanel from={from} to={to} /> : null}
        </TabsContent>
      </Tabs>

      {opened ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setOpenId(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{opened.patientName}</DialogTitle>
              <DialogDescription>
                {opened.appointmentTypeName} · {opened.locationName}
              </DialogDescription>
            </DialogHeader>
            <ChargeBody charge={opened} readOnly={readOnly} />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
