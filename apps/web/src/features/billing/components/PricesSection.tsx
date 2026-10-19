import {
  AppointmentTypeListResponse,
  money,
  type Money,
  type PayerPriceDto,
  type PriceDto,
} from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { formatCalendarDay, formatMoney } from '../../../shared/lib/format.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import { Input, Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { MoneyInput } from '../../../shared/ui/money-input.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { billingApi, billingKeys } from '../api/billing-api.js';
import { dayInZone } from '../domain/days.js';

import { ErrorAlert } from './ErrorAlert.js';

function useTypes() {
  const api = useApi();
  return useQuery({
    queryKey: ['billing', 'types'],
    queryFn: async () =>
      (await api.get('/appointment-types', { schema: AppointmentTypeListResponse })).types,
    staleTime: 60_000,
  });
}

function ActiveBadge({ active }: { active: boolean }) {
  const { t } = useTranslation('billing');
  return (
    <Badge tone={active ? 'success' : 'neutral'}>
      {active ? t('prices.active') : t('prices.inactive')}
    </Badge>
  );
}

function AddPriceForm() {
  const { t } = useTranslation('billing');
  const api = useApi();
  const queryClient = useQueryClient();
  const types = useTypes();
  const [typeId, setTypeId] = useState('');
  const [amount, setAmount] = useState<Money | null>(null);
  const [from, setFrom] = useState(dayInZone(new Date(), 'America/Argentina/Buenos_Aires'));

  const add = useMutation({
    mutationFn: () => {
      if (amount === null) throw new Error('the amount is missing');
      return billingApi(api).addPrice({
        appointmentTypeId: typeId,
        amountCents: amount,
        effectiveFrom: from,
      });
    },
    onSuccess: async () => {
      toast.success(t('prices.add.done'));
      setAmount(null);
      await queryClient.invalidateQueries({ queryKey: billingKeys.prices });
    },
  });
  const valid = typeId !== '' && amount !== null && amount > 0 && from !== '';

  return (
    <form
      className="grid gap-3 rounded-lg border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!add.isPending && valid) add.mutate();
      }}
    >
      <h3 className="font-display text-base font-semibold">{t('prices.add.title')}</h3>
      <div className="grid gap-1.5">
        <Label htmlFor="price-type">{t('prices.add.type')}</Label>
        <Select
          id="price-type"
          value={typeId}
          onChange={(event) => {
            setTypeId(event.target.value);
          }}
        >
          <option value="">{t('prices.add.chooseType')}</option>
          {(types.data ?? [])
            .filter((type) => type.active)
            .map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="price-amount">{t('prices.add.amount')}</Label>
        <MoneyInput id="price-amount" value={amount} onValueChange={setAmount} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="price-from">{t('prices.add.from')}</Label>
        <Input
          id="price-from"
          type="date"
          value={from}
          className="w-44"
          onChange={(event) => {
            setFrom(event.target.value);
          }}
        />
      </div>
      <ErrorAlert error={add.error} />
      <div>
        <Button type="submit" loading={add.isPending} disabled={!valid}>
          {t('prices.add.submit')}
        </Button>
      </div>
    </form>
  );
}

function AddPayerPriceForm() {
  const { t } = useTranslation('billing');
  const api = useApi();
  const queryClient = useQueryClient();
  const types = useTypes();
  const payers = useQuery({
    queryKey: billingKeys.payers,
    queryFn: () => billingApi(api).payers(),
  });
  const [payerId, setPayerId] = useState('');
  const [typeId, setTypeId] = useState('');
  const [plan, setPlan] = useState('');
  const [payerAmount, setPayerAmount] = useState<Money | null>(null);
  const [copago, setCopago] = useState<Money | null>(null);
  const [plus, setPlus] = useState<Money | null>(null);
  const [from, setFrom] = useState(dayInZone(new Date(), 'America/Argentina/Buenos_Aires'));

  const add = useMutation({
    mutationFn: () =>
      billingApi(api).addPayerPrice({
        tenantPayerId: payerId,
        appointmentTypeId: typeId,
        ...(plan.trim() === '' ? {} : { planName: plan.trim() }),
        payerAmountCents: payerAmount ?? money(0),
        copagoCents: copago ?? money(0),
        plusCents: plus ?? money(0),
        effectiveFrom: from,
      }),
    onSuccess: async () => {
      toast.success(t('prices.payerAdd.done'));
      setPayerAmount(null);
      setCopago(null);
      setPlus(null);
      await queryClient.invalidateQueries({ queryKey: billingKeys.prices });
    },
  });
  const total = (payerAmount ?? 0) + (copago ?? 0) + (plus ?? 0);
  const valid = payerId !== '' && typeId !== '' && total > 0 && from !== '';

  return (
    <form
      className="grid gap-3 rounded-lg border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!add.isPending && valid) add.mutate();
      }}
    >
      <h3 className="font-display text-base font-semibold">{t('prices.payerAdd.title')}</h3>
      <div className="grid gap-1.5">
        <Label htmlFor="pp-payer">{t('prices.payerAdd.payer')}</Label>
        <Select
          id="pp-payer"
          value={payerId}
          onChange={(event) => {
            setPayerId(event.target.value);
          }}
        >
          <option value="">{t('prices.payerAdd.choosePayer')}</option>
          {(payers.data?.payers ?? []).map((payer) => (
            <option key={payer.id} value={payer.id}>
              {payer.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="pp-plan">{t('prices.payerAdd.plan')}</Label>
        <Input
          id="pp-plan"
          value={plan}
          maxLength={80}
          onChange={(event) => {
            setPlan(event.target.value);
          }}
        />
        <p className="text-sm text-muted-foreground">{t('prices.payerAdd.planHint')}</p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="pp-type">{t('prices.add.type')}</Label>
        <Select
          id="pp-type"
          value={typeId}
          onChange={(event) => {
            setTypeId(event.target.value);
          }}
        >
          <option value="">{t('prices.add.chooseType')}</option>
          {(types.data ?? [])
            .filter((type) => type.active)
            .map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="pp-payer-amount">{t('prices.payerAdd.covered')}</Label>
        <MoneyInput id="pp-payer-amount" value={payerAmount} onValueChange={setPayerAmount} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="pp-copago">{t('prices.payerAdd.copago')}</Label>
        <MoneyInput id="pp-copago" value={copago} onValueChange={setCopago} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="pp-plus">{t('prices.payerAdd.plus')}</Label>
        <MoneyInput id="pp-plus" value={plus} onValueChange={setPlus} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="pp-from">{t('prices.add.from')}</Label>
        <Input
          id="pp-from"
          type="date"
          value={from}
          className="w-44"
          onChange={(event) => {
            setFrom(event.target.value);
          }}
        />
      </div>
      <ErrorAlert error={add.error} />
      <div>
        <Button type="submit" loading={add.isPending} disabled={!valid}>
          {t('prices.payerAdd.submit')}
        </Button>
      </div>
    </form>
  );
}

/** The price list: private prices and what each payer plan pays, with the forms to add them. */
export function PricesSection() {
  const { t } = useTranslation('billing');
  const api = useApi();
  const queryClient = useQueryClient();
  const prices = useQuery({
    queryKey: billingKeys.prices,
    queryFn: () => billingApi(api).prices(),
  });
  const toggle = useMutation({
    mutationFn: async (
      entry: { kind: 'price'; price: PriceDto } | { kind: 'payer'; price: PayerPriceDto },
    ) => {
      if (entry.kind === 'price') {
        await billingApi(api).updatePrice(entry.price.id, { active: !entry.price.active });
      } else {
        await billingApi(api).updatePayerPrice(entry.price.id, { active: !entry.price.active });
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: billingKeys.prices }),
  });

  if (prices.isPending) return <ListSkeleton rows={3} />;
  if (prices.isError) {
    return (
      <ErrorState
        error={prices.error}
        onRetry={() => {
          void prices.refetch();
        }}
      />
    );
  }

  return (
    <div className="grid gap-6">
      <section aria-labelledby="private-prices" className="grid gap-3">
        <h3 id="private-prices" className="font-display text-base font-semibold">
          {t('prices.private.title')}
        </h3>
        {prices.data.prices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('prices.private.empty')}</p>
        ) : (
          <ul className="grid gap-2">
            {prices.data.prices.map((price) => (
              <li
                key={price.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3"
              >
                <div className="min-w-0">
                  <p className="font-medium">
                    {price.appointmentTypeName}{' '}
                    <span className="tabular-nums">{formatMoney(price.amountCents)}</span>
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t('prices.since', { date: formatCalendarDay(price.effectiveFrom) })}
                    {price.professionalName ? ` · ${price.professionalName}` : ''}
                    {price.locationName ? ` · ${price.locationName}` : ''}
                    {price.specialty ? ` · ${price.specialty}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <ActiveBadge active={price.active} />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={
                      price.active
                        ? t('prices.deactivate', { name: price.appointmentTypeName })
                        : t('prices.activate', { name: price.appointmentTypeName })
                    }
                    onClick={() => {
                      toggle.mutate({ kind: 'price', price });
                    }}
                  >
                    {price.active ? t('prices.off') : t('prices.on')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <AddPriceForm />
      </section>

      <section aria-labelledby="payer-prices" className="grid gap-3">
        <h3 id="payer-prices" className="font-display text-base font-semibold">
          {t('prices.payer.title')}
        </h3>
        {prices.data.payerPrices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('prices.payer.empty')}</p>
        ) : (
          <ul className="grid gap-2">
            {prices.data.payerPrices.map((price) => (
              <li
                key={price.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3"
              >
                <div className="min-w-0 text-sm">
                  <p className="font-medium">
                    {price.payerName}
                    {price.planName ? ` · ${price.planName}` : ''} · {price.appointmentTypeName}
                  </p>
                  <p className="text-muted-foreground">
                    {t('prices.payer.split', {
                      covered: formatMoney(price.payerAmountCents),
                      copago: formatMoney(price.copagoCents),
                      plus: formatMoney(price.plusCents),
                    })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <ActiveBadge active={price.active} />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={
                      price.active
                        ? t('prices.deactivate', { name: price.payerName })
                        : t('prices.activate', { name: price.payerName })
                    }
                    onClick={() => {
                      toggle.mutate({ kind: 'payer', price });
                    }}
                  >
                    {price.active ? t('prices.off') : t('prices.on')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <AddPayerPriceForm />
      </section>
      <ErrorAlert error={toggle.error} />
    </div>
  );
}
