import { AFIP_SIMULATOR_MODES, type AfipSimulatorMode, type Money } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../../app/providers.js';
import { formatCalendarDay, formatMoney } from '../../../../shared/lib/format.js';
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

import { afipSimulatorApi, afipSimulatorKeys } from './simulator-api.js';

/** The list shows by itself what the issue job authorized in the meantime. */
const REFRESH_MS = 3000;

/**
 * The local AFIP simulator in the provider console: the vouchers it authorized, the mode it is in
 * (an outage, a slow answer, a timeout right after authorizing, the next request rejected) and a
 * reset that starts the numbering again without deleting anything.
 */
export function AfipSimulator() {
  const { t } = useTranslation('invoicing');
  const api = useApi();
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: afipSimulatorKeys.state,
    queryFn: () => afipSimulatorApi(api).state(),
    refetchInterval: REFRESH_MS,
  });
  const setMode = useMutation({
    mutationFn: (mode: AfipSimulatorMode) => afipSimulatorApi(api).setMode(mode),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: afipSimulatorKeys.state }),
  });
  const reset = useMutation({
    mutationFn: () => afipSimulatorApi(api).reset(),
    onSuccess: (fresh) => {
      toast.success(t('dev.reset.done'));
      queryClient.setQueryData(afipSimulatorKeys.state, fresh);
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
  const { mode, vouchers } = state.data;
  const failure = setMode.error ?? reset.error;

  return (
    <div className="grid max-w-4xl gap-4">
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
        aria-labelledby="afip-mode-title"
        className="grid gap-3 rounded-lg border bg-card p-4"
      >
        <h3 id="afip-mode-title" className="font-medium">
          {t('dev.mode.title')}
        </h3>
        <div className="grid gap-1.5">
          <Label htmlFor="afip-mode">{t('dev.mode.label')}</Label>
          <Select
            id="afip-mode"
            value={mode}
            onChange={(event) => {
              setMode.mutate(event.target.value as AfipSimulatorMode);
            }}
          >
            {AFIP_SIMULATOR_MODES.map((option) => (
              <option key={option} value={option}>
                {t(`dev.mode.${option}`)}
              </option>
            ))}
          </Select>
        </div>
      </section>

      <section
        aria-labelledby="afip-vouchers-title"
        className="grid gap-3 rounded-lg border bg-card p-4"
      >
        <h3 id="afip-vouchers-title" className="font-medium">
          {t('dev.vouchers.title')}
        </h3>
        {vouchers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('dev.vouchers.none')}</p>
        ) : (
          <TableContainer aria-label={t('dev.vouchers.caption')}>
            <Table>
              <TableCaption>{t('dev.vouchers.caption')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('dev.vouchers.col.organization')}</TableHead>
                  <TableHead>{t('dev.vouchers.col.issuer')}</TableHead>
                  <TableHead>{t('dev.vouchers.col.pointOfSale')}</TableHead>
                  <TableHead>{t('dev.vouchers.col.type')}</TableHead>
                  <TableHead>{t('dev.vouchers.col.number')}</TableHead>
                  <TableHead>{t('dev.vouchers.col.cae')}</TableHead>
                  <TableHead>{t('dev.vouchers.col.expires')}</TableHead>
                  <TableHead>{t('dev.vouchers.col.total')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {vouchers.map((voucher) => (
                  <TableRow key={voucher.id}>
                    <TableCell className="tabular">
                      {voucher.tenantRef === '' ? '—' : voucher.tenantRef.slice(0, 8)}
                    </TableCell>
                    <TableCell className="tabular">{voucher.issuerCuit}</TableCell>
                    <TableCell className="tabular">{voucher.pointOfSale}</TableCell>
                    <TableCell>{voucher.type}</TableCell>
                    <TableCell className="tabular">{voucher.number}</TableCell>
                    <TableCell className="tabular">{voucher.cae}</TableCell>
                    <TableCell className="tabular">
                      {formatCalendarDay(voucher.caeExpiresOn)}
                    </TableCell>
                    <TableCell className="tabular">
                      {formatMoney(voucher.totalCents as Money)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </section>

      <section
        aria-labelledby="afip-reset-title"
        className="grid gap-2 rounded-lg border bg-card p-4"
      >
        <h3 id="afip-reset-title" className="font-medium">
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
