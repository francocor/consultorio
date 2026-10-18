import {
  FISCAL_ENVIRONMENTS,
  type FiscalEnvironment,
  type PointOfSaleDto,
} from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { describeError } from '../../../shared/lib/translate.js';
import { Alert, AlertDescription } from '../../../shared/ui/alert.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import { Input, Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { toast } from '../../../shared/ui/toaster.js';
import { invoicingApi, invoicingKeys } from '../api/invoicing-api.js';
import { parsePointOfSale } from '../domain/forms.js';

/** The points of sale, each with its own AFIP environment, and a form to add one. */
export function PointsOfSaleSection({
  points,
  simulated,
}: {
  points: readonly PointOfSaleDto[];
  simulated: boolean;
}) {
  const { t } = useTranslation('invoicing');
  const api = useApi();
  const queryClient = useQueryClient();
  const [number, setNumber] = useState('');
  const [environment, setEnvironment] = useState<FiscalEnvironment>('homologation');
  const [attempted, setAttempted] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: invoicingKeys.config });
  const add = useMutation({
    mutationFn: (body: { number: number; environment: FiscalEnvironment }) =>
      invoicingApi(api).addPointOfSale(body),
    onSuccess: async () => {
      toast.success(t('pos.added'));
      setNumber('');
      setAttempted(false);
      await refresh();
    },
  });
  const update = useMutation({
    mutationFn: (input: {
      id: string;
      body: { environment?: FiscalEnvironment; active?: boolean };
    }) => invoicingApi(api).updatePointOfSale(input.id, input.body),
    onSuccess: async () => {
      toast.success(t('pos.updated'));
      await refresh();
    },
  });

  const parsed = parsePointOfSale(number);
  const numberError = attempted && parsed === null ? t('pos.error.number') : null;
  const failure = add.error ?? update.error;

  const submit = () => {
    setAttempted(true);
    if (parsed !== null) add.mutate({ number: parsed, environment });
  };

  return (
    <section aria-labelledby="pos-title" className="grid gap-3 rounded-lg border bg-card p-4">
      <div className="grid gap-0.5">
        <h3 id="pos-title" className="font-medium">
          {t('pos.title')}
        </h3>
        <p className="text-sm text-muted-foreground">{t('pos.description')}</p>
        {simulated ? <p className="text-sm text-muted-foreground">{t('pos.simulated')}</p> : null}
      </div>

      {failure ? (
        <Alert tone="danger">
          <AlertDescription>{describeError(t, failure).message}</AlertDescription>
        </Alert>
      ) : null}

      {points.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('pos.none')}</p>
      ) : (
        <ul aria-label={t('pos.title')} className="grid gap-3">
          {points.map((point) => (
            <li
              key={point.id}
              className="flex flex-wrap items-end justify-between gap-3 rounded-md border p-3"
            >
              <div className="grid gap-1">
                <p className="font-medium">{t('pos.item', { number: point.number })}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={point.active ? 'success' : 'neutral'}>
                    {point.active ? t('pos.active') : t('pos.inactive')}
                  </Badge>
                  <Badge tone={point.environment === 'production' ? 'info' : 'warning'}>
                    {t(`env.${point.environment}`)}
                  </Badge>
                </div>
                {point.effectiveEnvironment !== point.environment ? (
                  <p className="text-xs text-muted-foreground">
                    {t('pos.effective', { environment: t(`env.${point.effectiveEnvironment}`) })}
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="grid gap-1.5">
                  <Label htmlFor={`pos-env-${point.id}`} className="sr-only">
                    {t('pos.environmentOf', { number: point.number })}
                  </Label>
                  <Select
                    id={`pos-env-${point.id}`}
                    value={point.environment}
                    onChange={(event) => {
                      update.mutate({
                        id: point.id,
                        body: { environment: event.target.value as FiscalEnvironment },
                      });
                    }}
                  >
                    {FISCAL_ENVIRONMENTS.map((option) => (
                      <option key={option} value={option}>
                        {t(`env.${option}`)}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    update.mutate({ id: point.id, body: { active: !point.active } });
                  }}
                >
                  {point.active
                    ? t('pos.deactivate', { number: point.number })
                    : t('pos.activate', { number: point.number })}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex flex-wrap items-start gap-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="pos-number">{t('pos.number')}</Label>
          <Input
            id="pos-number"
            inputMode="numeric"
            className="w-32"
            value={number}
            aria-invalid={numberError ? true : undefined}
            aria-describedby={numberError ? 'pos-number-error' : 'pos-number-help'}
            onChange={(event) => {
              setNumber(event.target.value);
            }}
          />
          {numberError ? (
            <p id="pos-number-error" className="text-sm text-destructive">
              {numberError}
            </p>
          ) : (
            <p id="pos-number-help" className="text-xs text-muted-foreground">
              {t('pos.numberHelp')}
            </p>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pos-environment">{t('pos.environment')}</Label>
          <Select
            id="pos-environment"
            value={environment}
            onChange={(event) => {
              setEnvironment(event.target.value as FiscalEnvironment);
            }}
          >
            {FISCAL_ENVIRONMENTS.map((option) => (
              <option key={option} value={option}>
                {t(`env.${option}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="self-start sm:pt-6">
          <Button type="submit" loading={add.isPending}>
            {add.isPending ? t('pos.adding') : t('pos.add')}
          </Button>
        </div>
      </form>
    </section>
  );
}
