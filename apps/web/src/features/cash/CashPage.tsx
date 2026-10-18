import { money, type CashSessionDto, type LocationDto, type Money } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { RequirePermission } from '../../app/guards.js';
import { useApi, useAppStatus } from '../../app/providers.js';
import { useMe } from '../../app/session.js';
import { SimulatedBillingNotice } from '../../app/SimulatedBillingNotice.js';
import { usePageTitle } from '../../app/use-page-title.js';
import { locationsApi, LOCATIONS_QUERY_KEY } from '../../shared/api/locations-api.js';
import { formatDateTime, formatMoney } from '../../shared/lib/format.js';
import { Alert, AlertDescription } from '../../shared/ui/alert.js';
import { Button } from '../../shared/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../shared/ui/dialog.js';
import { Select } from '../../shared/ui/input.js';
import { Label } from '../../shared/ui/label.js';
import { MoneyInput } from '../../shared/ui/money-input.js';
import { PageHeader } from '../../shared/ui/page-header.js';
import { EmptyState } from '../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../shared/ui/toaster.js';
import { billingApi, billingKeys, ErrorAlert } from '../billing/index.js';

import { CloseRegisterDialog } from './components/CloseRegisterDialog.js';
import { EntriesList } from './components/EntriesList.js';

/** The cash register: open it for the location, see the day by method, close it with the count. */
export function CashPage() {
  return (
    <RequirePermission anyOf={['cash.operate']}>
      <Cash />
    </RequirePermission>
  );
}

function OpenRegister({ location, disabled }: { location: LocationDto; disabled: boolean }) {
  const { t } = useTranslation('cash');
  const api = useApi();
  const queryClient = useQueryClient();
  const [opening, setOpening] = useState<Money | null>(null);

  const open = useMutation({
    mutationFn: () => {
      if (opening === null) throw new Error('the opening cash is missing');
      return billingApi(api).openCash({ locationId: location.id, openingCents: opening });
    },
    onSuccess: async () => {
      toast.success(t('open.done'));
      setOpening(null);
      await queryClient.invalidateQueries({ queryKey: billingKeys.all });
    },
    onError: async () => {
      // Someone opened it meanwhile: show that register instead of the form.
      await queryClient.invalidateQueries({ queryKey: billingKeys.all });
    },
  });

  return (
    <form
      className="grid max-w-md gap-4 rounded-lg border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!open.isPending && opening !== null) open.mutate();
      }}
    >
      <Alert tone="info">
        <AlertDescription>{t('open.none', { location: location.name })}</AlertDescription>
      </Alert>
      <div className="grid gap-1.5">
        <Label htmlFor="open-amount">{t('open.amount')}</Label>
        <MoneyInput
          id="open-amount"
          value={opening}
          onValueChange={setOpening}
          disabled={disabled}
        />
        <p className="text-sm text-muted-foreground">{t('open.hint')}</p>
      </div>
      <ErrorAlert error={open.error} />
      <div>
        <Button type="submit" loading={open.isPending} disabled={disabled || opening === null}>
          {t('open.submit')}
        </Button>
      </div>
    </form>
  );
}

function SessionSummary({ session }: { session: CashSessionDto }) {
  const { t } = useTranslation('cash');
  return (
    <div className="grid gap-4">
      <dl className="grid gap-1 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{t('summary.opening')}</dt>
          <dd className="tabular-nums">{formatMoney(session.openingCents)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{t('summary.cashIn')}</dt>
          <dd className="tabular-nums">{formatMoney(session.cashInCents)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{t('summary.cashOut')}</dt>
          <dd className="tabular-nums">{formatMoney(session.cashOutCents)}</dd>
        </div>
        <div className="flex justify-between gap-4 text-base font-semibold">
          <dt>{t('summary.expected')}</dt>
          <dd className="tabular-nums">{formatMoney(session.expectedCents)}</dd>
        </div>
        {session.status === 'closed' && session.countedCents !== null ? (
          <>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('summary.counted')}</dt>
              <dd className="tabular-nums">{formatMoney(session.countedCents)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('summary.difference')}</dt>
              <dd className="tabular-nums">{formatMoney(session.differenceCents ?? money(0))}</dd>
            </div>
          </>
        ) : null}
      </dl>
      {session.differenceReason ? (
        <p className="text-sm text-muted-foreground">
          {t('summary.reason', { reason: session.differenceReason })}
        </p>
      ) : null}

      {session.byMethod.length > 0 ? (
        <table className="w-full text-sm">
          <caption className="pb-1 text-left font-medium">{t('summary.byMethod')}</caption>
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="py-1 font-normal">
                {t('summary.method')}
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                {t('summary.payments')}
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                {t('summary.refunds')}
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                {t('summary.net')}
              </th>
            </tr>
          </thead>
          <tbody>
            {session.byMethod.map((row) => (
              <tr key={row.method} className="border-t">
                <th scope="row" className="py-1 text-left font-normal">
                  {t(`method.${row.method}`)}
                </th>
                <td className="py-1 text-right tabular-nums">{formatMoney(row.paymentsCents)}</td>
                <td className="py-1 text-right tabular-nums">{formatMoney(row.refundsCents)}</td>
                <td className="py-1 text-right tabular-nums font-medium">
                  {formatMoney(row.netCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-muted-foreground">{t('summary.noMovements')}</p>
      )}
    </div>
  );
}

/** A register with its entries, open or closed. */
function SessionDetail({ id, canCorrect }: { id: string; canCorrect: boolean }) {
  const { t } = useTranslation('cash');
  const api = useApi();
  const detail = useQuery({
    queryKey: billingKeys.cashSession(id),
    queryFn: () => billingApi(api).cashSession(id),
  });
  if (detail.isPending) return <ListSkeleton rows={3} />;
  if (detail.isError) {
    return (
      <ErrorState
        error={detail.error}
        onRetry={() => {
          void detail.refetch();
        }}
      />
    );
  }
  return (
    <div className="grid gap-4">
      <SessionSummary session={detail.data.session} />
      <section aria-labelledby={`entries-${id}`} className="grid gap-2">
        <h3 id={`entries-${id}`} className="text-sm font-semibold">
          {t('entries.title')}
        </h3>
        <EntriesList entries={detail.data.entries} canCorrect={canCorrect} />
      </section>
    </div>
  );
}

function Cash() {
  const { t } = useTranslation(['cash', 'common']);
  usePageTitle(t('cash:title'));
  const api = useApi();
  const me = useMe();
  const appStatus = useAppStatus();
  const readOnly = appStatus.readOnly || me.tenantStatus === 'read_only';
  const [chosen, setChosen] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);

  const locations = useQuery({
    queryKey: [...LOCATIONS_QUERY_KEY, 'cash'],
    queryFn: () => locationsApi(api).list(),
    staleTime: 60_000,
  });
  const places = (locations.data ?? []).filter((place) => place.active);
  const location = places.find((place) => place.id === chosen) ?? places[0];

  const current = useQuery({
    queryKey: billingKeys.cashCurrent(location?.id ?? ''),
    queryFn: () => billingApi(api).cashCurrent(location?.id ?? ''),
    enabled: location !== undefined,
  });
  const history = useQuery({
    queryKey: billingKeys.cashList(location?.id ?? ''),
    queryFn: () => billingApi(api).cashSessions(location?.id ?? '', 'closed'),
    enabled: location !== undefined,
  });
  const open = current.data?.session ?? null;

  return (
    <div className="grid grid-cols-1 gap-4">
      <PageHeader title={t('cash:title')} description={t('cash:description')} className="mb-0" />
      <SimulatedBillingNotice />

      {locations.isPending ? <ListSkeleton rows={2} /> : null}
      {locations.isError ? (
        <ErrorState
          error={locations.error}
          onRetry={() => {
            void locations.refetch();
          }}
        />
      ) : null}
      {locations.isSuccess && places.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title={t('cash:noLocations.title')}
          description={t('cash:noLocations.description')}
        />
      ) : null}

      {places.length > 1 ? (
        <div className="grid max-w-xs gap-1.5">
          <Label htmlFor="cash-location">{t('cash:location')}</Label>
          <Select
            id="cash-location"
            value={location?.id ?? ''}
            onChange={(event) => {
              setChosen(event.target.value);
            }}
          >
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      {readOnly ? (
        <Alert tone="warning">
          <AlertDescription>{t('common:state.readOnly.disabledReason')}</AlertDescription>
        </Alert>
      ) : null}

      {location && current.isPending ? <ListSkeleton rows={3} /> : null}
      {current.isError ? (
        <ErrorState
          error={current.error}
          onRetry={() => {
            void current.refetch();
          }}
        />
      ) : null}

      {location && current.isSuccess && open === null ? (
        <OpenRegister location={location} disabled={readOnly} />
      ) : null}

      {open ? (
        <section
          aria-labelledby="open-register"
          className="grid gap-4 rounded-lg border bg-card p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="open-register" className="font-display text-lg font-semibold">
                {t('cash:open.title', { location: open.locationName })}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t('cash:open.since', { at: formatDateTime(open.openedAt) })}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={readOnly}
              onClick={() => {
                setClosing(true);
              }}
            >
              <Lock aria-hidden="true" />
              {t('cash:close.open')}
            </Button>
          </div>
          <SessionDetail id={open.id} canCorrect={!readOnly} />
        </section>
      ) : null}

      {location && history.data && history.data.sessions.length > 0 ? (
        <section aria-labelledby="history-title" className="grid gap-2">
          <h2 id="history-title" className="font-display text-lg font-semibold">
            {t('cash:history.title')}
          </h2>
          <ul className="grid gap-2">
            {history.data.sessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3 text-sm"
              >
                <span>
                  {formatDateTime(session.openedAt)} · {t('cash:history.counted')}{' '}
                  <span className="tabular-nums">
                    {formatMoney(session.countedCents ?? money(0))}
                  </span>
                  {session.differenceCents !== null && session.differenceCents !== 0
                    ? ` · ${t('cash:history.difference', { amount: formatMoney(session.differenceCents) })}`
                    : ''}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setViewing(session.id);
                  }}
                >
                  {t('cash:history.view', { date: formatDateTime(session.openedAt) })}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {closing && open ? (
        <CloseRegisterDialog
          session={open}
          onClose={() => {
            setClosing(false);
          }}
        />
      ) : null}
      {viewing ? (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setViewing(null);
          }}
        >
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t('cash:history.detail')}</DialogTitle>
              <DialogDescription>
                {open ? t('cash:history.correctHint') : t('cash:history.noOpenHint')}
              </DialogDescription>
            </DialogHeader>
            {/* A correction goes into the register that is open: without one it is not offered. */}
            <SessionDetail id={viewing} canCorrect={open !== null && !readOnly} />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
