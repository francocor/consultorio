import {
  CHARGE_LINE_PORTIONS,
  type ChargeDto,
  type ChargeLinePortion,
  type Money,
} from '@consultorio/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApi } from '../../../app/providers.js';
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
import { MoneyInput } from '../../../shared/ui/money-input.js';
import { toast } from '../../../shared/ui/toaster.js';
import { billingApi, billingKeys } from '../api/billing-api.js';

import { ErrorAlert } from './ErrorAlert.js';

/** Adds a line (material, a study) to a charge. A line is never edited afterwards. */
export function AddLineDialog({ charge, onClose }: { charge: ChargeDto; onClose: () => void }) {
  const { t } = useTranslation(['billing', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState<Money | null>(null);
  const [portion, setPortion] = useState<ChargeLinePortion>('patient');
  const valid = description.trim().length > 0 && amount !== null && amount > 0;

  const add = useMutation({
    mutationFn: () => {
      if (amount === null) throw new Error('the amount is missing');
      return billingApi(api).addLine(charge.id, {
        description: description.trim(),
        amountCents: amount,
        portion,
      });
    },
    onSuccess: async () => {
      toast.success(t('billing:line.done'));
      await queryClient.invalidateQueries({ queryKey: billingKeys.all });
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
          <DialogTitle>{t('billing:line.title')}</DialogTitle>
          <DialogDescription>{t('billing:line.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!add.isPending && valid) add.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="line-description">{t('billing:line.descriptionLabel')}</Label>
            <Input
              id="line-description"
              value={description}
              maxLength={200}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="line-amount">{t('billing:line.amount')}</Label>
            <MoneyInput id="line-amount" value={amount} onValueChange={setAmount} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="line-portion">{t('billing:line.portion')}</Label>
            <Select
              id="line-portion"
              value={portion}
              onChange={(event) => {
                setPortion(event.target.value as ChargeLinePortion);
              }}
            >
              {CHARGE_LINE_PORTIONS.map((option) => (
                <option key={option} value={option}>
                  {t(`billing:portion.${option}`)}
                </option>
              ))}
            </Select>
          </div>
          <ErrorAlert error={add.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button type="submit" loading={add.isPending} disabled={!valid}>
              {t('billing:line.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
