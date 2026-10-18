import { formatCuit, type TenantPayerDto } from '@consultorio/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
import { Badge } from '../../../shared/ui/badge.js';
import { Button } from '../../../shared/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../shared/ui/dialog.js';
import { Input, Select } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { EmptyState } from '../../../shared/ui/states/empty-state.js';
import { ErrorState } from '../../../shared/ui/states/error-state.js';
import { ListSkeleton } from '../../../shared/ui/states/loading-skeleton.js';
import { toast } from '../../../shared/ui/toaster.js';
import { billingApi, billingKeys } from '../api/billing-api.js';

import { ErrorAlert } from './ErrorAlert.js';

/** Sets or removes the CUIT of a payer. The server checks the digits and the check digit. */
function CuitDialog({ payer, onClose }: { payer: TenantPayerDto; onClose: () => void }) {
  const { t } = useTranslation(['billing', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [cuit, setCuit] = useState(payer.cuit ? formatCuit(payer.cuit) : '');
  const save = useMutation({
    mutationFn: () =>
      billingApi(api).updatePayer(payer.id, { cuit: cuit.trim() === '' ? null : cuit.trim() }),
    onSuccess: async () => {
      toast.success(t('billing:payers.cuit.done'));
      await queryClient.invalidateQueries({ queryKey: billingKeys.payers });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('billing:payers.cuit.title', { name: payer.name })}</DialogTitle>
          <DialogDescription>{t('billing:payers.cuit.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!save.isPending) save.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="payer-cuit">{t('billing:payers.cuit.label')}</Label>
            <Input
              id="payer-cuit"
              value={cuit}
              inputMode="numeric"
              autoComplete="off"
              placeholder="30-12345678-1"
              maxLength={20}
              onChange={(event) => {
                setCuit(event.target.value);
              }}
            />
          </div>
          <ErrorAlert error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button type="submit" loading={save.isPending}>
              {t('billing:payers.cuit.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddPayerForm({ available }: { available: { payerId: string; name: string }[] }) {
  const { t } = useTranslation('billing');
  const api = useApi();
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState('');
  const [customName, setCustomName] = useState('');
  const [cuit, setCuit] = useState('');

  const add = useMutation({
    mutationFn: () => {
      const tax = cuit.trim() === '' ? {} : { cuit: cuit.trim() };
      return billingApi(api).addPayer(
        choice === '' ? { customName: customName.trim(), ...tax } : { payerId: choice, ...tax },
      );
    },
    onSuccess: async () => {
      toast.success(t('payers.add.done'));
      setChoice('');
      setCustomName('');
      setCuit('');
      await queryClient.invalidateQueries({ queryKey: billingKeys.payers });
    },
  });
  const valid = choice !== '' || customName.trim().length >= 2;

  return (
    <form
      className="grid gap-3 rounded-lg border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!add.isPending && valid) add.mutate();
      }}
    >
      <h3 className="font-display text-base font-semibold">{t('payers.add.title')}</h3>
      <div className="grid gap-1.5">
        <Label htmlFor="payer-catalog">{t('payers.add.fromCatalog')}</Label>
        <Select
          id="payer-catalog"
          value={choice}
          onChange={(event) => {
            setChoice(event.target.value);
          }}
        >
          <option value="">{t('payers.add.none')}</option>
          {available.map((payer) => (
            <option key={payer.payerId} value={payer.payerId}>
              {payer.name}
            </option>
          ))}
        </Select>
      </div>
      {choice === '' ? (
        <div className="grid gap-1.5">
          <Label htmlFor="payer-custom">{t('payers.add.custom')}</Label>
          <Input
            id="payer-custom"
            value={customName}
            maxLength={80}
            onChange={(event) => {
              setCustomName(event.target.value);
            }}
          />
        </div>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor="payer-add-cuit">{t('payers.cuit.label')}</Label>
        <Input
          id="payer-add-cuit"
          value={cuit}
          inputMode="numeric"
          autoComplete="off"
          maxLength={20}
          onChange={(event) => {
            setCuit(event.target.value);
          }}
        />
      </div>
      <ErrorAlert error={add.error} />
      <div>
        <Button type="submit" loading={add.isPending} disabled={!valid}>
          {t('payers.add.submit')}
        </Button>
      </div>
    </form>
  );
}

/** The payers the organization bills: copy from the catalog, name your own, set the CUIT, switch on and off. */
export function PayersSection() {
  const { t } = useTranslation('billing');
  const api = useApi();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<TenantPayerDto | null>(null);
  const payers = useQuery({
    queryKey: billingKeys.payers,
    queryFn: () => billingApi(api).payers(),
  });
  const toggle = useMutation({
    mutationFn: (payer: TenantPayerDto) =>
      billingApi(api).updatePayer(payer.id, { active: !payer.active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: billingKeys.payers }),
  });

  if (payers.isPending) return <ListSkeleton rows={3} />;
  if (payers.isError) {
    return (
      <ErrorState
        error={payers.error}
        onRetry={() => {
          void payers.refetch();
        }}
      />
    );
  }

  return (
    <div className="grid gap-4">
      {payers.data.payers.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={t('payers.empty.title')}
          description={t('payers.empty.description')}
        />
      ) : (
        <ul aria-label={t('payers.caption')} className="grid gap-2">
          {payers.data.payers.map((payer) => (
            <li
              key={payer.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{payer.name}</p>
                <p className="text-sm text-muted-foreground">
                  {payer.cuit
                    ? t('payers.cuit.value', { cuit: formatCuit(payer.cuit) })
                    : t('payers.cuit.missing')}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={payer.active ? 'success' : 'neutral'}>
                  {payer.active ? t('payers.active') : t('payers.inactive')}
                </Badge>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditing(payer);
                  }}
                >
                  <Pencil aria-hidden="true" />
                  {t('payers.cuit.edit', { name: payer.name })}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  loading={toggle.isPending && toggle.variables.id === payer.id}
                  onClick={() => {
                    toggle.mutate(payer);
                  }}
                >
                  {payer.active
                    ? t('payers.deactivate', { name: payer.name })
                    : t('payers.activate', { name: payer.name })}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ErrorAlert error={toggle.error} />
      <AddPayerForm available={payers.data.available} />
      {editing ? (
        <CuitDialog
          payer={editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}
