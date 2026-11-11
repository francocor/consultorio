import {
  PAYMENTS_SIMULATOR_MODES,
  type Money,
  type PaymentsSimulatorMode,
} from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../../app/providers.js';
import { formatDateTime, formatMoney } from '../../../../shared/lib/format.js';
import { describeError } from '../../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../../shared/ui/alert.js';
import { Button } from '../../../../shared/ui/button.js';
import { Select } from '../../../../shared/ui/input.js';
import { Label } from '../../../../shared/ui/label.js';
import { ErrorState } from '../../../../shared/ui/states/error-state.js';
import { FormSkeleton } from '../../../../shared/ui/states/loading-skeleton.js';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../../shared/ui/table.js';
import { toast } from '../../../../shared/ui/toaster.js';

import { paymentsSimulatorApi, paymentsSimulatorKeys } from './simulator-api.js';

/** The list shows by itself what the webhook and the reconcile did in the meantime. */
const REFRESH_MS = 3000;

const money = (cents: number) => formatMoney(cents as Money);

/**
 * The local Mercado Pago in the provider console: the authorizations and payments it holds, the mode
 * it is in (an outage, a lost answer, a refused change of amount, duplicated or disordered notices), a
 * control that runs the billing cycle now, and a reset that makes it forget everything it holds.
 */
export function PaymentsSimulator() {
  const { t } = useTranslation('subscription');
  const api = useApi();
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: paymentsSimulatorKeys.state,
    queryFn: () => paymentsSimulatorApi(api).state(),
    refetchInterval: REFRESH_MS,
  });
  const setMode = useMutation({
    mutationFn: (mode: PaymentsSimulatorMode) => paymentsSimulatorApi(api).setMode(mode),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: paymentsSimulatorKeys.state }),
  });
  const cycle = useMutation({
    mutationFn: (outcome: 'approved' | 'rejected') => paymentsSimulatorApi(api).runCycle(outcome),
    onSuccess: async (result) => {
      toast.success(t('dev.cycle.done', { charged: result.charged, delivered: result.delivered }));
      await queryClient.invalidateQueries({ queryKey: paymentsSimulatorKeys.state });
    },
  });
  const reset = useMutation({
    mutationFn: () => paymentsSimulatorApi(api).reset(),
    onSuccess: (fresh) => {
      toast.success(t('dev.reset.done'));
      queryClient.setQueryData(paymentsSimulatorKeys.state, fresh);
    },
  });

  if (state.isPending) return <FormSkeleton fields={3} />;
  if (state.isError) {
    return (
      <ErrorState
        error={state.error}
        onRetry={() => {
          void state.refetch();
        }}
      />
    );
  }
  const { mode, preapprovals, payments } = state.data;
  const failure = setMode.error ?? cycle.error ?? reset.error;

  return (
    <div className="grid max-w-4xl min-w-0 gap-4">
      <div className="grid gap-1">
        <h2 className="font-display text-lg font-semibold">{t('dev.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('dev.description')}</p>
      </div>

      {failure ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, failure).message}</AlertDescription>
        </Alert>
      ) : null}

      <section
        aria-labelledby="payments-mode-title"
        className="grid gap-3 rounded-lg border bg-card p-4"
      >
        <h3 id="payments-mode-title" className="font-medium">
          {t('dev.mode.title')}
        </h3>
        <div className="grid gap-1.5">
          <Label htmlFor="payments-mode">{t('dev.mode.label')}</Label>
          <Select
            id="payments-mode"
            value={mode}
            onChange={(event) => {
              setMode.mutate(event.target.value as PaymentsSimulatorMode);
            }}
          >
            {PAYMENTS_SIMULATOR_MODES.map((option) => (
              <option key={option} value={option}>
                {t(`dev.mode.${option}`)}
              </option>
            ))}
          </Select>
        </div>
      </section>

      <section
        aria-labelledby="payments-cycle-title"
        className="grid gap-2 rounded-lg border bg-card p-4"
      >
        <h3 id="payments-cycle-title" className="font-medium">
          {t('dev.cycle.title')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('dev.cycle.description')}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            loading={cycle.isPending}
            onClick={() => {
              cycle.mutate('approved');
            }}
          >
            {t('dev.cycle.approved')}
          </Button>
          <Button
            type="button"
            variant="outline"
            loading={cycle.isPending}
            onClick={() => {
              cycle.mutate('rejected');
            }}
          >
            {t('dev.cycle.rejected')}
          </Button>
        </div>
      </section>

      <section
        aria-labelledby="payments-preapprovals-title"
        className="grid min-w-0 gap-3 rounded-lg border bg-card p-4"
      >
        <h3 id="payments-preapprovals-title" className="font-medium">
          {t('dev.preapprovals.title')}
        </h3>
        {preapprovals.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('dev.preapprovals.none')}</p>
        ) : (
          <TableContainer aria-label={t('dev.preapprovals.caption')}>
            <Table>
              <TableCaption>{t('dev.preapprovals.caption')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('dev.col.id')}</TableHead>
                  <TableHead>{t('dev.col.reference')}</TableHead>
                  <TableHead>{t('dev.col.status')}</TableHead>
                  <TableHead>{t('dev.col.amount')}</TableHead>
                  <TableHead>{t('dev.col.createdAt')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preapprovals.map((entry) => (
                  <TableRow key={entry.preapprovalId}>
                    <TableCell className="tabular">{entry.preapprovalId}</TableCell>
                    <TableCell className="tabular">{entry.reference}</TableCell>
                    <TableCell>{entry.status}</TableCell>
                    <TableCell className="tabular">{money(entry.amountCents)}</TableCell>
                    <TableCell className="tabular">{formatDateTime(entry.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </section>

      <section
        aria-labelledby="payments-payments-title"
        className="grid min-w-0 gap-3 rounded-lg border bg-card p-4"
      >
        <h3 id="payments-payments-title" className="font-medium">
          {t('dev.payments.title')}
        </h3>
        {payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('dev.payments.none')}</p>
        ) : (
          <TableContainer aria-label={t('dev.payments.caption')}>
            <Table>
              <TableCaption>{t('dev.payments.caption')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('dev.col.id')}</TableHead>
                  <TableHead>{t('dev.col.reference')}</TableHead>
                  <TableHead>{t('dev.col.status')}</TableHead>
                  <TableHead>{t('dev.col.amount')}</TableHead>
                  <TableHead>{t('dev.col.refunded')}</TableHead>
                  <TableHead>{t('dev.col.createdAt')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.map((entry) => (
                  <TableRow key={entry.paymentId}>
                    <TableCell className="tabular">{entry.paymentId}</TableCell>
                    <TableCell className="tabular">{entry.reference}</TableCell>
                    <TableCell>{entry.status}</TableCell>
                    <TableCell className="tabular">{money(entry.amountCents)}</TableCell>
                    <TableCell className="tabular">{money(entry.refundedCents)}</TableCell>
                    <TableCell className="tabular">{formatDateTime(entry.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </section>

      <section
        aria-labelledby="payments-reset-title"
        className="grid gap-2 rounded-lg border bg-card p-4"
      >
        <h3 id="payments-reset-title" className="font-medium">
          {t('dev.reset.title')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('dev.reset.description')}</p>
        <div>
          <Button
            type="button"
            variant="outline"
            loading={reset.isPending}
            onClick={() => {
              reset.mutate();
            }}
          >
            {t('dev.reset.button')}
          </Button>
        </div>
      </section>
    </div>
  );
}
