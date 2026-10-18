import { INVOICE_STATUSES, type InvoiceStatus } from '@consultorio/contracts';
import { useQuery } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { RequirePermission } from '../../app/guards.js';
import { useApi, useAppStatus } from '../../app/providers.js';
import { hasAnyPermission, useMe } from '../../app/session.js';
import { SimulatedBillingNotice } from '../../app/SimulatedBillingNotice.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Select } from '../../shared/ui/input.js';
import { Label } from '../../shared/ui/label.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../shared/ui/tabs.js';

import { invoicingApi, invoicingKeys, type InvoiceFilters } from './api/invoicing-api.js';
import { ChargesToInvoice } from './components/ChargesToInvoice.js';
import { InvoiceCard } from './components/InvoiceCard.js';
import { InvoiceDetailDialog } from './components/InvoiceDetailDialog.js';

/** How often the list looks again while some invoice is pending: the badge follows the authority. */
const POLL_MS = 5000;

/** The invoices: what was asked for, what is pending, issued, rejected or registered by hand. */
export function InvoicesPage() {
  return (
    <RequirePermission anyOf={['invoicing.issue']}>
      <Invoices />
    </RequirePermission>
  );
}

function Invoices() {
  const { t } = useTranslation(['invoicing', 'common']);
  usePageTitle(t('invoicing:page.title'));
  const api = useApi();
  const me = useMe();
  const appStatus = useAppStatus();
  const readOnly = appStatus.readOnly || me.tenantStatus === 'read_only';
  const [status, setStatus] = useState<InvoiceStatus | ''>('');
  const [openId, setOpenId] = useState<string | null>(null);
  const canSeeCharges = hasAnyPermission(me.permissions, ['payments.read']);
  const canConfigure = hasAnyPermission(me.permissions, ['invoicing.configure']);

  const filters: InvoiceFilters = status === '' ? {} : { status };
  const list = useQuery({
    queryKey: invoicingKeys.invoices(filters),
    queryFn: () => invoicingApi(api).invoices(filters),
    refetchInterval: (query) =>
      query.state.data?.invoices.some((entry) => entry.status === 'pending') ? POLL_MS : false,
  });
  const readiness = useQuery({
    queryKey: invoicingKeys.readiness,
    queryFn: () => invoicingApi(api).readiness(),
  });
  // The pending ones that waited too long, wherever the filter is: the owner sees them first.
  const pending = useQuery({
    queryKey: invoicingKeys.invoices({ status: 'pending' }),
    queryFn: () => invoicingApi(api).invoices({ status: 'pending' }),
    refetchInterval: (query) => ((query.state.data?.invoices.length ?? 0) > 0 ? POLL_MS : false),
  });

  const invoices = list.data?.invoices ?? [];
  const thresholdHours =
    list.data?.outageThresholdHours ?? pending.data?.outageThresholdHours ?? 24;
  const prolonged = pending.data?.invoices.filter((entry) => entry.outageFlag).length ?? 0;
  const opened =
    invoices.find((entry) => entry.id === openId) ??
    pending.data?.invoices.find((entry) => entry.id === openId);
  const blockers = readiness.data && !readiness.data.available ? readiness.data.reasons : [];

  return (
    <div className="grid grid-cols-1 gap-4">
      <PageHeader
        title={t('invoicing:page.title')}
        description={t('invoicing:page.description')}
        className="mb-0"
      />
      <SimulatedBillingNotice />

      {blockers.length > 0 ? (
        <Alert tone="warning">
          <AlertDescription>
            <span className="block font-medium">{t('invoicing:page.blocked')}</span>
            <ul className="mt-1 list-disc pl-5">
              {blockers.map((reason) => (
                <li key={reason}>{t(`invoicing:readiness.reason.${reason}`)}</li>
              ))}
            </ul>
            {canConfigure ? (
              <span className="mt-1 block">{t('invoicing:page.blockedOwner')}</span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {prolonged > 0 ? (
        <Alert tone="danger">
          <AlertDescription>
            <span className="block font-medium">
              {t('invoicing:outage.banner', { count: prolonged, hours: thresholdHours })}
            </span>
            <span className="mt-1 block">{t('invoicing:outage.bannerHelp')}</span>
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs defaultValue="invoices">
        <TabsList>
          <TabsTrigger value="invoices">{t('invoicing:tabs.invoices')}</TabsTrigger>
          {canSeeCharges ? (
            <TabsTrigger value="charges">{t('invoicing:tabs.charges')}</TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent value="invoices" className="grid grid-cols-1 gap-3 pt-4">
          <div className="grid max-w-xs gap-1.5">
            <Label htmlFor="invoices-status">{t('invoicing:filter.status')}</Label>
            <Select
              id="invoices-status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as InvoiceStatus | '');
              }}
            >
              <option value="">{t('invoicing:filter.anyStatus')}</option>
              {INVOICE_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {t(`invoicing:status.${option}`)}
                </option>
              ))}
            </Select>
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
          {list.isSuccess && invoices.length === 0 ? (
            <EmptyState
              icon={FileText}
              title={t('invoicing:list.empty.title')}
              description={t('invoicing:list.empty.description')}
            />
          ) : null}
          {invoices.length > 0 ? (
            <ul aria-label={t('invoicing:list.caption')} className="grid grid-cols-1 gap-3">
              {invoices.map((invoice) => (
                <InvoiceCard
                  key={invoice.id}
                  invoice={invoice}
                  thresholdHours={thresholdHours}
                  onOpen={() => {
                    setOpenId(invoice.id);
                  }}
                />
              ))}
            </ul>
          ) : null}
        </TabsContent>

        {canSeeCharges ? (
          <TabsContent value="charges" className="pt-4">
            <ChargesToInvoice readOnly={readOnly} />
          </TabsContent>
        ) : null}
      </Tabs>

      {opened ? (
        <InvoiceDetailDialog
          invoice={opened}
          readOnly={readOnly}
          thresholdHours={thresholdHours}
          onClose={() => {
            setOpenId(null);
          }}
        />
      ) : null}
    </div>
  );
}
