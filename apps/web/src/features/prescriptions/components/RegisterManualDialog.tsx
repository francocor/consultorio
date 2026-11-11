import type { PrescriptionDto } from '@consultorio/contracts';
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
import { Input } from '../../../shared/ui/input.js';
import { Label } from '../../../shared/ui/label.js';
import { toast } from '../../../shared/ui/toaster.js';
import { prescriptionKeys, prescriptionsApi } from '../api/prescriptions-api.js';

import { ErrorAlert } from './ErrorAlert.js';

/**
 * Registers the identifier of a prescription the professional issued directly on the site of the
 * provider (e-prescription, "Manual fallback registration"): it is stored as issued and flagged
 * "registrada a mano". It is for a prescription the provider has not confirmed; one whose answer may
 * have been lost waits until the provider has been asked.
 */
export function RegisterManualDialog({
  prescription,
  onClose,
}: {
  prescription: PrescriptionDto;
  onClose: () => void;
}) {
  const { t } = useTranslation(['prescriptions', 'common']);
  const api = useApi();
  const queryClient = useQueryClient();
  const [identifier, setIdentifier] = useState('');
  const valid = identifier.trim().length > 0;

  const register = useMutation({
    mutationFn: () =>
      prescriptionsApi(api).registerManual(prescription.id, { identifier: identifier.trim() }),
    onSuccess: async () => {
      toast.success(t('prescriptions:register.done'));
      await queryClient.invalidateQueries({ queryKey: prescriptionKeys.all });
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
          <DialogTitle>{t('prescriptions:register.title')}</DialogTitle>
          <DialogDescription>{t('prescriptions:register.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!register.isPending && valid) register.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="register-identifier">{t('prescriptions:register.identifier')}</Label>
            <Input
              id="register-identifier"
              value={identifier}
              maxLength={80}
              autoComplete="off"
              onChange={(event) => {
                setIdentifier(event.target.value);
              }}
            />
          </div>
          <ErrorAlert error={register.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button type="submit" loading={register.isPending} disabled={!valid}>
              {t('prescriptions:register.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
