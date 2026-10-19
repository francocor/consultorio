import { ERX_SIMULATOR_MODES, type ErxSimulatorMode } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../../app/providers.js';
import { formatDateTime } from '../../../../shared/lib/format.js';
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

import { erxSimulatorApi, erxSimulatorKeys } from './simulator-api.js';

/** The list shows by itself what the submit job issued in the meantime. */
const REFRESH_MS = 3000;

/**
 * The local e-prescription simulator in the provider console: the prescriptions it issued (an
 * identifier, a state and a time: never a medication or a patient), the mode it is in (an outage, an
 * answer lost after issuing), what a pharmacy or the calendar does to a prescription (dispensed,
 * expired: the application is notified through its own webhook) and a reset that forgets everything
 * without deleting anything.
 */
export function ErxSimulator() {
  const { t } = useTranslation('prescriptions');
  const api = useApi();
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: erxSimulatorKeys.state,
    queryFn: () => erxSimulatorApi(api).state(),
    refetchInterval: REFRESH_MS,
  });
  const setMode = useMutation({
    mutationFn: (mode: ErxSimulatorMode) => erxSimulatorApi(api).setMode(mode),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: erxSimulatorKeys.state }),
  });
  const advance = useMutation({
    mutationFn: (input: { externalId: string; to: 'dispensed' | 'expired' }) =>
      erxSimulatorApi(api).advance(input.externalId, input.to),
    onSuccess: async (result) => {
      if (result.delivered) toast.success(t('dev.advance.done'));
      else toast.warning(t('dev.advance.notDelivered'));
      await queryClient.invalidateQueries({ queryKey: erxSimulatorKeys.state });
    },
  });
  const reset = useMutation({
    mutationFn: () => erxSimulatorApi(api).reset(),
    onSuccess: (fresh) => {
      toast.success(t('dev.reset.done'));
      queryClient.setQueryData(erxSimulatorKeys.state, fresh);
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
  const { mode, prescriptions } = state.data;
  const failure = setMode.error ?? advance.error ?? reset.error;

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
        aria-labelledby="erx-mode-title"
        className="grid gap-3 rounded-lg border bg-card p-4"
      >
        <h3 id="erx-mode-title" className="font-medium">
          {t('dev.mode.title')}
        </h3>
        <div className="grid gap-1.5">
          <Label htmlFor="erx-mode">{t('dev.mode.label')}</Label>
          <Select
            id="erx-mode"
            value={mode}
            onChange={(event) => {
              setMode.mutate(event.target.value as ErxSimulatorMode);
            }}
          >
            {ERX_SIMULATOR_MODES.map((option) => (
              <option key={option} value={option}>
                {t(`dev.mode.${option}`)}
              </option>
            ))}
          </Select>
        </div>
      </section>

      <section
        aria-labelledby="erx-prescriptions-title"
        className="grid gap-3 rounded-lg border bg-card p-4"
      >
        <h3 id="erx-prescriptions-title" className="font-medium">
          {t('dev.prescriptions.title')}
        </h3>
        {prescriptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('dev.prescriptions.none')}</p>
        ) : (
          <TableContainer aria-label={t('dev.prescriptions.caption')}>
            <Table>
              <TableCaption>{t('dev.prescriptions.caption')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('dev.prescriptions.col.identifier')}</TableHead>
                  <TableHead>{t('dev.prescriptions.col.state')}</TableHead>
                  <TableHead>{t('dev.prescriptions.col.createdAt')}</TableHead>
                  <TableHead>{t('dev.prescriptions.col.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {prescriptions.map((prescription) => (
                  <TableRow key={prescription.externalId}>
                    <TableCell className="tabular">{prescription.externalId}</TableCell>
                    <TableCell>{t(`dev.state.${prescription.state}`)}</TableCell>
                    <TableCell className="tabular">
                      {formatDateTime(prescription.createdAt)}
                    </TableCell>
                    <TableCell>
                      {prescription.state === 'issued' ? (
                        <span className="flex flex-wrap gap-2">
                          {(['dispensed', 'expired'] as const).map((to) => (
                            <Button
                              key={to}
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={advance.isPending}
                              aria-label={t(`dev.advance.${to}Of`, { id: prescription.externalId })}
                              onClick={() => {
                                advance.mutate({ externalId: prescription.externalId, to });
                              }}
                            >
                              {t(`dev.advance.${to}`)}
                            </Button>
                          ))}
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </section>

      <section
        aria-labelledby="erx-reset-title"
        className="grid gap-2 rounded-lg border bg-card p-4"
      >
        <h3 id="erx-reset-title" className="font-medium">
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
